"""Supabase (PostgREST) sink for eBay comp snapshots — issue #6.

Companion to ``motherduck.py``: writes the same comp snapshot row dicts the
scraper already builds (``scraper/ebay_comps.py``) to the Supabase
``ebay_comp_snapshots`` table over the PostgREST REST API. Writes use the
secret key (``SUPABASE_SECRET_KEY``), which bypasses row-level security; the
browser reads the deduplicated ``public_auction_comps`` view with the
publishable key. The secret key must never reach the browser bundle.

Selected via ``GOONERS_WAREHOUSE=supabase`` through the :mod:`warehouse` seam,
so no comp-fetch call sites change.
"""

import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal

COMP_SNAPSHOT_TABLE = "ebay_comp_snapshots"

# Columns written per row. `id` (identity) and `ingested_at` (default now())
# are filled by Postgres and deliberately omitted. Mirrors the MotherDuck insert
# column list in scraper/ebay_comps.py so the same row dict serializes to either.
COMP_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "status",
    "query",
    "search_url",
    "fetched_at",
    "warning",
    "ebay_item_id",
    "title",
    "price_value",
    "price_currency",
    "shipping_label",
    "sold_date",
    "sold_date_label",
    "thumbnail_url",
    "item_web_url",
    "condition",
    "source_query",
    "match_confidence",
    "auction_id",
    "lot_number",
    "cannons_title",
    "cannons_description",
    "current_bid",
    "total_bids",
    "detail_url",
    "raw_match_json",
)

# PostgREST accepts large arrays, but keep batches bounded so a big backfill
# doesn't build one giant request body.
DEFAULT_BATCH_SIZE = 500


def json_safe(value):
    """Coerce a row value into something ``json.dumps`` can emit for PostgREST."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def row_payload(row: dict) -> dict:
    """Project a comp row dict onto the table columns, JSON-safe."""
    return {column: json_safe(row.get(column)) for column in COMP_COLUMNS}


def resolve_credentials(
    url: str | None = None, key: str | None = None
) -> tuple[str | None, str | None]:
    """Resolve (project URL, secret key) from args or env.

    Reads ``SUPABASE_URL`` (falling back to ``VITE_SUPABASE_URL``, which the
    deploy/build env already sets) and the backend-only ``SUPABASE_SECRET_KEY``.
    """
    url = url or os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
    key = key or os.environ.get("SUPABASE_SECRET_KEY")
    return url, key


def append_ebay_comp_snapshots(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Append comp snapshot rows to Supabase. Returns rows written."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write comps to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write comps to Supabase")

    import requests

    session = session or requests.Session()
    endpoint = f"{url.rstrip('/')}/rest/v1/{COMP_SNAPSHOT_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = [row_payload(row) for row in rows[start : start + batch_size]]
        response = session.post(
            endpoint, headers=headers, data=json.dumps(batch), timeout=30
        )
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase comp insert failed ({response.status_code}): "
                f"{response.text[:300]}"
            )
        written += len(batch)
    return written
