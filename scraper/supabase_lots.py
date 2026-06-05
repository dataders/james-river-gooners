"""Active + archived lot listings → Supabase (issue #98).

Mirrors the NDJSON read model into the Supabase ``lots`` table so the browser
queries PostgREST on tab open instead of 21 parallel file fetches. The browser
still loads the full dataset and filters client-side, so filter/sort/search
latency is unchanged.

Writes use the secret key (bypasses RLS); the browser reads
``public_active_lots`` / ``public_archived_lots`` with the publishable key.

CLI usage (one-time backfill of existing NDJSON files):
    uv run --with requests python3 supabase_lots.py --backfill
    uv run --with requests python3 supabase_lots.py --backfill --active-only
    uv run --with requests python3 supabase_lots.py --backfill --archived-only
"""

import argparse
import json
import os
from pathlib import Path
from typing import Optional

from supabase_comps import json_safe, resolve_credentials

LOTS_TABLE = "lots"
DEFAULT_BATCH_SIZE = 500

_REPO_ROOT = Path(__file__).resolve().parent.parent
ITEMS_DIR = _REPO_ROOT / "public" / "data" / "items"
ARCHIVE_ITEMS_DIR = _REPO_ROOT / "public" / "data" / "archive" / "items"


def _to_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _lot_row(item: dict, archived: bool = False) -> dict:
    """Convert a camelCase NDJSON item dict to a snake_case Supabase row."""
    images = item.get("images", [])
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except Exception:
            images = [images] if images else []

    row: dict = {
        "auction_safe_id": item.get("auctionSafeId"),
        "item_id": item.get("id"),
        "lot_number": item.get("lotNumber"),
        "title": item.get("title"),
        "description": item.get("description"),
        "current_bid": _to_float(item.get("currentBid")),
        "total_bids": item.get("totalBids"),
        "unique_bidders": item.get("uniqueBidders"),
        "end_date": item.get("endDate"),
        "images": images,
        "category": item.get("category"),
        "raw_category": item.get("rawCategory"),
        "detail_url": item.get("detailUrl"),
        "auction_id": item.get("auctionId"),
        "auction_title": item.get("auctionTitle"),
        "auction_end_date": item.get("auctionEndDate"),
        "scraped_at": item.get("scrapedAt"),
        "source": item.get("source"),
        "archived": archived,
    }
    if archived:
        row["final_bid"] = _to_float(item.get("finalBid"))
        row["closed"] = item.get("closed")
    return {k: json_safe(v) for k, v in row.items()}


def _post_batch(rows: list[dict], url: str, key: str) -> None:
    import requests

    endpoint = f"{url.rstrip('/')}/rest/v1/{LOTS_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    resp = requests.post(endpoint, json=rows, headers=headers)
    resp.raise_for_status()


def upsert_lots(
    items: list[dict],
    safe_id: str,
    *,
    url: str = None,
    key: str = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Upsert active items for one auction into ``lots``. Returns row count."""
    url, key = resolve_credentials(url, key)
    if not url or not key:
        return 0

    rows = [_lot_row(item) for item in items]
    for i in range(0, len(rows), batch_size):
        _post_batch(rows[i : i + batch_size], url, key)

    print(f"Upserted {len(rows)} lots for {safe_id} to Supabase")
    return len(rows)


def archive_lots(
    safe_id: str,
    final_items: list[dict],
    *,
    url: str = None,
    key: str = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Mark all lots for ``safe_id`` as archived and write final prices."""
    url, key = resolve_credentials(url, key)
    if not url or not key:
        return 0

    rows = [_lot_row(item, archived=True) for item in final_items]
    for i in range(0, len(rows), batch_size):
        _post_batch(rows[i : i + batch_size], url, key)

    print(f"Archived {len(rows)} lots for {safe_id} in Supabase")
    return len(rows)


def backfill(
    *,
    url: str = None,
    key: str = None,
    do_active: bool = True,
    do_archived: bool = True,
) -> tuple[int, int]:
    """Read all existing NDJSON files and upsert into Supabase.

    Returns ``(active_count, archived_count)``.
    """
    url, key = resolve_credentials(url, key)
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY are required for backfill")

    active_total = 0
    if do_active and ITEMS_DIR.exists():
        paths = sorted(ITEMS_DIR.glob("*.ndjson"))
        print(f"Backfilling {len(paths)} active auction file(s)…")
        for ndjson_path in paths:
            items = [json.loads(l) for l in ndjson_path.read_text().splitlines() if l.strip()]
            if items:
                active_total += upsert_lots(items, ndjson_path.stem, url=url, key=key)

    archived_total = 0
    if do_archived and ARCHIVE_ITEMS_DIR.exists():
        paths = sorted(ARCHIVE_ITEMS_DIR.glob("*.ndjson"))
        print(f"Backfilling {len(paths)} archived auction file(s)…")
        for ndjson_path in paths:
            items = [json.loads(l) for l in ndjson_path.read_text().splitlines() if l.strip()]
            if items:
                archived_total += archive_lots(ndjson_path.stem, items, url=url, key=key)

    return active_total, archived_total


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill existing NDJSON files into the Supabase lots table"
    )
    parser.add_argument("--backfill", action="store_true", help="Run the backfill")
    parser.add_argument("--active-only", action="store_true", help="Backfill active lots only")
    parser.add_argument("--archived-only", action="store_true", help="Backfill archived lots only")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    if not args.backfill:
        print("Pass --backfill to run. See --help for options.")
        raise SystemExit(1)

    active_count, archived_count = backfill(
        do_active=not args.archived_only,
        do_archived=not args.active_only,
    )
    print(f"Backfill complete: {active_count} active lots, {archived_count} archived lots")
