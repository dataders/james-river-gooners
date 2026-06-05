#!/usr/bin/env python3
"""
LLM lot enrichment → Supabase (issue #104).

``scraper/enrich.py`` writes brand/model/condition/etc. onto each lot dict, and
those fields persist to the NDJSON/Parquet read model. This module additionally
mirrors the *enriched* lots into a Supabase ``lot_enrichment`` table so the
metadata is queryable via the API (``public_lot_enrichment`` view, publishable
key), keyed on ``(auction_safe_id, item_id)`` — the same shape as
``sold_lots``/``sold_history.py``.

Only lots that actually got enriched (a non-empty ``enrichmentConfidence``) are
written, so the table stays a clean index of *identified* products rather than a
row per lot. Writes use the backend-only secret key (``SUPABASE_SECRET_KEY``)
via the same PostgREST upsert mechanics as ``supabase_comps.py`` /
``sold_history.py``; the call is a silent no-op when the key is absent, so a
scrape without Supabase configured behaves unchanged.

Called inline after each scrape (``maybe_export_enrichment``); also runnable as a
script to backfill the table from an already-enriched read model:

    python supabase_enrichment.py [<safeId> ...]   # default: all active auctions
"""

import argparse
import json
import sys
from pathlib import Path

from supabase_comps import json_safe, resolve_credentials

ENRICHMENT_TABLE = "lot_enrichment"

# Columns written per row; mirrors the `lot_enrichment` table
# (0007_lot_enrichment.sql). `updated_at` is Postgres-filled and omitted.
ENRICHMENT_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "auction_id",
    "auction_title",
    "lot_number",
    "title",
    "category",
    "raw_category",
    "brand",
    "model_or_sku",
    "condition",
    "product_url",
    "confidence",
    "model",
    "image_url",
    "detail_url",
    "source",
)

DEFAULT_ITEMS_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "items"
DEFAULT_BATCH_SIZE = 500


def _first_image(lot: dict) -> str | None:
    images = lot.get("images")
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except (ValueError, TypeError):
            return None
    if isinstance(images, list) and images:
        return str(images[0])
    return None


def enrichment_row(lot: dict) -> dict | None:
    """Project a lot dict onto a `lot_enrichment` row, or None when the lot
    carries no enrichment (empty confidence)."""
    confidence = str(lot.get("enrichmentConfidence") or "").strip().lower()
    if not confidence:
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
        "category": lot.get("category"),
        "raw_category": lot.get("rawCategory"),
        "brand": lot.get("brand") or "",
        "model_or_sku": lot.get("modelOrSku") or "",
        "condition": lot.get("condition") or "",
        "product_url": lot.get("productUrl") or "",
        "confidence": confidence,
        "model": lot.get("enrichmentModel") or "",
        "image_url": _first_image(lot),
        "detail_url": lot.get("detailUrl"),
        "source": lot.get("source"),
    }
    return {column: json_safe(row.get(column)) for column in ENRICHMENT_COLUMNS}


def build_enrichment_rows(items: list[dict]) -> list[dict]:
    """Build `lot_enrichment` rows for every enriched lot (last write wins on key)."""
    rows: dict[tuple[str, str], dict] = {}
    for lot in items:
        row = enrichment_row(lot)
        if row:
            rows[(row["auction_safe_id"], row["item_id"])] = row
    return list(rows.values())


def upsert_enrichment(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Upsert `lot_enrichment` rows into Supabase (merge on the primary key)."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write enrichment to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write enrichment to Supabase")

    import requests

    session = session or requests.Session()
    endpoint = f"{url.rstrip('/')}/rest/v1/{ENRICHMENT_TABLE}"
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
                f"Supabase lot_enrichment upsert failed ({response.status_code}): {response.text[:300]}"
            )
        written += len(batch)
    return written


def maybe_export_enrichment(items: list[dict], session=None) -> int:
    """Inline post-scrape hook: upsert enriched lots when Supabase is configured.

    Silent no-op when there's no secret key or no enriched lots, so a scrape
    without Supabase (or with enrichment off) behaves exactly as before."""
    url, key = resolve_credentials()
    if not (url and key):
        return 0
    rows = build_enrichment_rows(items)
    if not rows:
        return 0
    written = upsert_enrichment(rows, url=url, key=key, session=session)
    print(f"  upserted {written} enrichment row(s) to Supabase")
    return written


def _iter_ndjson(path: Path):
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def export_from_read_model(safe_ids: list[str], items_dir: Path = DEFAULT_ITEMS_DIR, **kwargs) -> int:
    """Backfill the table from already-enriched NDJSON sidecars."""
    paths = (
        [items_dir / f"{safe_id}.ndjson" for safe_id in safe_ids]
        if safe_ids
        else sorted(items_dir.glob("*.ndjson"))
    )
    lots = []
    for path in paths:
        if path.exists():
            lots.extend(_iter_ndjson(path))
    rows = build_enrichment_rows(lots)
    written = upsert_enrichment(rows, **kwargs)
    print(f"Upserted {written} enrichment row(s) from {len(paths)} file(s)")
    return written


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upsert LLM lot enrichment to Supabase")
    parser.add_argument("safe_ids", nargs="*", help="Auction safeIds (default: all active)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        export_from_read_model(args.safe_ids)
    except RuntimeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
