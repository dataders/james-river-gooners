# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
# ]
# ///
"""Cannon's historical sold prices → Supabase (issue #95 / M3.2).

Reads the archive read model (``public/data/archive/items/*.ndjson``) — the
record of what every closed lot sold for — and upserts one row per sold lot into
the Supabase ``sold_lots`` table, keyed on ``(auction_safe_id, item_id)``. The
browser reads the ``public_sold_lots`` / ``public_category_sold_stats`` views
(publishable key) to surface past sold prices (#96) and rank best-margin items
(#97), so margin queries are dynamic instead of baked into a static read model.

Final price per lot: ``finalBid`` when the archive carries it (#94), else the
last-seen ``currentBid`` (lots archived before #94). A lot that closed with no
bid (price 0) didn't sell and is skipped.

Writes use the secret key (``SUPABASE_SECRET_KEY``) via the same PostgREST
mechanics as ``supabase_comps.py``, but as an **upsert** (merge on the primary
key) so re-running over the whole archive is idempotent and also backfills lots
that predate #94. Run as a script (see ``.github/workflows/sold-history.yml``).
"""

import argparse
import json
import sys
from pathlib import Path

from dates import parse_auction_datetime_utc
from supabase_comps import json_safe, resolve_credentials

SOLD_LOTS_TABLE = "sold_lots"

# Columns written per row; mirrors the `sold_lots` table (0006_sold_history.sql).
# `updated_at` is Postgres-filled (default now()) and deliberately omitted.
SOLD_LOT_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "auction_id",
    "auction_title",
    "lot_number",
    "title",
    "description",
    "category",
    "raw_category",
    "final_bid",
    "total_bids",
    "unique_bidders",
    "sold_at",
    "image_url",
    "detail_url",
    "source",
)

# Default archive location relative to the repo root (scraper/ is one level down).
DEFAULT_ARCHIVE_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "archive" / "items"

# PostgREST accepts large arrays; keep batches bounded so a full-archive backfill
# doesn't build one giant request body.
DEFAULT_BATCH_SIZE = 500


def _to_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def final_price(lot: dict) -> float | None:
    """The price a lot sold for: ``finalBid`` if set (#94), else last ``currentBid``.

    Returns None for a lot that drew no bid (price 0) — it didn't sell, so it
    carries no sold price.
    """
    final = _to_float(lot.get("finalBid"))
    if final is None:
        final = _to_float(lot.get("currentBid"))
    if final is None or final <= 0:
        return None
    return final


def first_image(lot: dict) -> str | None:
    images = lot.get("images")
    if isinstance(images, str):
        # Parquet stringifies the array; NDJSON keeps it as a list. Be tolerant.
        try:
            images = json.loads(images)
        except (ValueError, TypeError):
            return images or None
    if isinstance(images, list) and images:
        return images[0]
    return None


def sold_at(lot: dict):
    """When the lot closed — its own end date, falling back to the auction's."""
    return parse_auction_datetime_utc(lot.get("endDate")) or parse_auction_datetime_utc(
        lot.get("auctionEndDate")
    )


def sold_lot_row(lot: dict) -> dict | None:
    """Project an archived lot dict onto a `sold_lots` row, or None if it didn't sell."""
    price = final_price(lot)
    if price is None:
        return None
    safe_id = lot.get("auctionSafeId")
    item_id = lot.get("id")
    if not safe_id or item_id in (None, ""):
        return None

    row = {
        "auction_safe_id": safe_id,
        "item_id": str(item_id),
        "auction_id": lot.get("auctionId"),
        "auction_title": lot.get("auctionTitle"),
        "lot_number": lot.get("lotNumber"),
        "title": lot.get("title"),
        "description": lot.get("description"),
        "category": lot.get("category"),
        "raw_category": lot.get("rawCategory"),
        "final_bid": price,
        "total_bids": lot.get("totalBids"),
        "unique_bidders": lot.get("uniqueBidders"),
        "sold_at": sold_at(lot),
        "image_url": first_image(lot),
        "detail_url": lot.get("detailUrl"),
        "source": lot.get("source"),
    }
    return {column: json_safe(row.get(column)) for column in SOLD_LOT_COLUMNS}


def iter_archive_lots(archive_dir: Path):
    """Yield every lot dict from the archive NDJSON sidecars."""
    if not archive_dir.exists():
        return
    for path in sorted(archive_dir.glob("*.ndjson")):
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def build_sold_lot_rows(archive_dir: Path = DEFAULT_ARCHIVE_DIR) -> list[dict]:
    """Build `sold_lots` rows for every sold lot in the archive.

    A safe_id+item_id may appear in more than one snapshot; the last one wins
    (archive rewrites are idempotent, so they carry identical prices anyway).
    """
    rows: dict[tuple[str, str], dict] = {}
    for lot in iter_archive_lots(archive_dir):
        row = sold_lot_row(lot)
        if row:
            rows[(row["auction_safe_id"], row["item_id"])] = row
    return list(rows.values())


def upsert_sold_lots(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Upsert `sold_lots` rows into Supabase (merge on the primary key). Returns rows written."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write sold history to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write sold history to Supabase")

    from http_client import supabase_session

    session = session or supabase_session("sold-history")
    endpoint = f"{url.rstrip('/')}/rest/v1/{SOLD_LOTS_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        # Upsert on the (auction_safe_id, item_id) primary key.
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        response = session.post(endpoint, headers=headers, data=json.dumps(batch), timeout=30)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase sold_lots upsert failed ({response.status_code}): {response.text[:300]}"
            )
        written += len(batch)
    return written


def export_sold_history(archive_dir: Path = DEFAULT_ARCHIVE_DIR, **kwargs) -> int:
    rows = build_sold_lot_rows(archive_dir)
    written = upsert_sold_lots(rows, **kwargs)
    print(f"Upserted {written} sold lot(s) from {archive_dir}")
    return written


def iter_lots_from_supabase(session=None):
    """Yield archived lot dicts from the Supabase ``lots`` table."""
    from supabase_lots import list_auction_safe_ids, fetch_lots_for_auction

    from http_client import supabase_session
    session = session or supabase_session("sold-history")
    safe_ids = list_auction_safe_ids(archived=True, session=session)
    print(f"Found {len(safe_ids)} archived auction(s) in Supabase")
    for safe_id in safe_ids:
        for item in fetch_lots_for_auction(safe_id, archived=True, session=session):
            yield item


def build_sold_lot_rows_from_supabase(session=None) -> list[dict]:
    """Build ``sold_lots`` rows by reading archived lots from Supabase."""
    rows: dict[tuple[str, str], dict] = {}
    for lot in iter_lots_from_supabase(session=session):
        row = sold_lot_row(lot)
        if row:
            rows[(row["auction_safe_id"], row["item_id"])] = row
    return list(rows.values())


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upsert Cannon's sold-price history to Supabase")
    parser.add_argument(
        "--archive-dir",
        type=Path,
        default=DEFAULT_ARCHIVE_DIR,
        help="Archive items directory (default: public/data/archive/items)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Build rows and report the count without writing to Supabase",
    )
    parser.add_argument(
        "--from-supabase",
        action="store_true",
        help="Read archived lots from the Supabase lots table instead of NDJSON files",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.from_supabase:
        rows = build_sold_lot_rows_from_supabase()
    else:
        rows = build_sold_lot_rows(args.archive_dir)
    if args.dry_run:
        source = "Supabase" if args.from_supabase else str(args.archive_dir)
        print(f"[dry-run] {len(rows)} sold lot(s) from {source}")
        return 0
    if args.from_supabase:
        written = upsert_sold_lots(rows)
        print(f"Upserted {written} sold lot(s) from Supabase")
    else:
        export_sold_history(args.archive_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
