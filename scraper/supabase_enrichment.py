#!/usr/bin/env python3
"""
LLM lot enrichment → Supabase (issue #104).

``scraper/enrich.py`` writes brand/model/condition/etc. onto each lot dict, and
those fields persist to the NDJSON/Parquet read model. This module additionally
mirrors the *enriched* lots into a Supabase ``lot_enrichment`` table so the
metadata is queryable via the API (``public_lot_enrichment`` view, publishable
key), keyed on ``(auction_safe_id, item_id)`` — the same shape as
``sold_lots``/``sold_history.py``.

Only confidently identified lots (``enrichmentConfidence`` of medium or high —
the same display bar as the UI) are written, so the table stays a clean index of
*identified* products rather than a row per lot. Writes use the backend-only secret key (``SUPABASE_SECRET_KEY``)
via the same PostgREST upsert mechanics as ``supabase_comps.py`` /
``sold_history.py``. Transient failures (network errors, 429, 5xx) are retried
with exponential backoff; a permanent failure raises. The inline post-scrape
hook (``maybe_export_enrichment``) is resilient: it **warns** rather than
crashing the scrape (the local NDJSON/Parquet read model is the primary
deliverable), and warns when Supabase is half-configured (URL set, secret key
missing). It is a true no-op only when Supabase is entirely unconfigured or no
lots were enriched.

Called inline after each scrape (``maybe_export_enrichment``); also runnable as a
script to backfill the table from an already-enriched read model:

    python supabase_enrichment.py [<safeId> ...]   # default: all active auctions
"""

import argparse
import json
import sys
import time
from pathlib import Path

from supabase_comps import READ_TIMEOUT, json_safe, resolve_credentials

ENRICHMENT_TABLE = "lot_enrichment"

# Columns written per row; mirrors the `lot_enrichment` table
# (0009_lot_enrichment.sql). `updated_at` is Postgres-filled and omitted.
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
    "product_type",
    "search_query",
    "condition",
    "product_url",
    "brand_confidence",
    "model_confidence",
    "quantity",
    "is_mixed_lot",
    "condition_flags",
    "key_attributes",
    "secondary_items",
    "detail_category",
    "details",
    "detail_confidence",
    "confidence",
    "model",
    "image_url",
    "detail_url",
    "source",
    "input_hash",
)

DEFAULT_ITEMS_DIR = Path(__file__).resolve().parent.parent / "public" / "data" / "items"
DEFAULT_BATCH_SIZE = 500

# Retry transient failures (network errors, rate limits, 5xx) with exponential
# backoff (2s, 4s, 8s, 16s) — the same convention used elsewhere in the project.
DEFAULT_MAX_RETRIES = 4


def _is_transient(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _post_batch_with_retry(session, endpoint, headers, batch, max_retries, sleep=None):
    """POST one batch, retrying transient failures; raise on permanent failure."""
    import requests

    sleep = sleep or time.sleep  # resolved at call time so tests can patch time.sleep
    body = json.dumps(batch)
    for attempt in range(max_retries + 1):
        try:
            response = session.post(endpoint, headers=headers, data=body, timeout=READ_TIMEOUT)
        except requests.exceptions.RequestException as exc:
            if attempt >= max_retries:
                raise RuntimeError(
                    f"Supabase lot_enrichment upsert failed after {attempt + 1} attempt(s): {exc}"
                ) from exc
            sleep(2 ** (attempt + 1))
            continue

        if response.status_code < 400:
            return
        if _is_transient(response.status_code) and attempt < max_retries:
            sleep(2 ** (attempt + 1))
            continue
        raise RuntimeError(
            f"Supabase lot_enrichment upsert failed ({response.status_code}): {response.text[:300]}"
        )


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


# The display bar: only medium/high lots are mirrored, matching what the UI shows
# (src/utils/enrichment.js). Low/absent confidence is noise (often empty brand) —
# keeping it out makes the table a clean index of identified products.
DISPLAY_CONFIDENCES = frozenset({"medium", "high"})


def enrichment_row(lot: dict) -> dict | None:
    """Project a lot dict onto a `lot_enrichment` row, or None when the lot isn't
    confidently identified (confidence below the medium/high display bar)."""
    confidence = str(lot.get("enrichmentConfidence") or "").strip().lower()
    if confidence not in DISPLAY_CONFIDENCES:
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
        "product_type": lot.get("productType") or "",
        "search_query": lot.get("searchQuery") or "",
        "condition": lot.get("condition") or "",
        "product_url": lot.get("productUrl") or "",
        "brand_confidence": lot.get("brandConfidence") or "",
        "model_confidence": lot.get("modelConfidence") or "",
        "quantity": lot.get("quantity") or "",
        "is_mixed_lot": lot.get("isMixedLot") or "",
        "condition_flags": lot.get("conditionFlags") or "",
        "key_attributes": lot.get("keyAttributes") or "",
        "secondary_items": lot.get("secondaryItems") or "",
        "detail_category": lot.get("detailCategory") or "",
        "details": lot.get("details") or "",
        "detail_confidence": lot.get("detailConfidence") or "",
        "confidence": confidence,
        "model": lot.get("enrichmentModel") or "",
        "image_url": _first_image(lot),
        "detail_url": lot.get("detailUrl"),
        "source": lot.get("source"),
        "input_hash": lot.get("enrichmentInputHash") or "",
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
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> int:
    """Upsert `lot_enrichment` rows into Supabase (merge on the primary key).

    Retries transient failures (network, 429, 5xx) with backoff; raises
    RuntimeError on missing credentials or a permanent failure."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write enrichment to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write enrichment to Supabase")

    from http_client import supabase_session

    session = session or supabase_session("enrich")
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
        _post_batch_with_retry(session, endpoint, headers, batch, max_retries)
        written += len(batch)
    return written


def maybe_export_enrichment(items: list[dict], session=None) -> int:
    """Inline post-scrape hook: upsert enriched lots when Supabase is configured.

    Resilient by design — the scrape's primary output is the local read model, so
    a Supabase failure must never crash it:
      - No Supabase at all → quiet no-op (feature off).
      - URL set but no secret key → warn (likely a misconfiguration), no-op.
      - No enriched lots → quiet no-op.
      - Upsert fails after retries → warn loudly, but don't raise.
    The strict, raising path lives in ``upsert_enrichment`` for deliberate
    backfills (the CLI), where a non-zero exit is what you want."""
    url, key = resolve_credentials()
    if not key:
        if url:
            print("  WARNING: SUPABASE_URL is set but SUPABASE_SECRET_KEY is not — "
                  "skipping enrichment mirror to Supabase")
        return 0
    rows = build_enrichment_rows(items)
    if not rows:
        return 0
    try:
        written = upsert_enrichment(rows, url=url, key=key, session=session)
    except RuntimeError as exc:
        print(f"  WARNING: failed to mirror {len(rows)} enrichment row(s) to Supabase: {exc}")
        return 0
    print(f"  upserted {written} enrichment row(s) to Supabase")
    return written


def load_prior_enrichment_from_supabase(
    safe_id: str,
    *,
    url: str = None,
    key: str = None,
    session=None,
) -> dict:
    """Load prior enrichment for one auction from the lot_enrichment table.

    Returns ``{item_id: camelCase_dict}`` in the same shape as
    ``enrich.load_prior_enrichment`` so callers can use either interchangeably.
    The dict has at minimum all ENRICHMENT_FIELDS (brand, modelOrSku, …,
    enrichmentInputHash) needed by ``enrich.reuse_prior_enrichment``.

    Returns an empty dict when Supabase is unconfigured or the table has no rows
    for this auction yet (first scrape of a new auction).
    """
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials(url, key)
    if not url or not key:
        return {}

    from http_client import supabase_session

    session = session or supabase_session("enrich")
    endpoint = f"{url.rstrip('/')}/rest/v1/{ENRICHMENT_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    PAGE = 1000
    rows = []
    offset = 0
    while True:
        resp = session.get(
            endpoint,
            headers={**headers, "Range": f"{offset}-{offset + PAGE - 1}"},
            params={"auction_safe_id": f"eq.{safe_id}", "select": "*"},
            timeout=READ_TIMEOUT,
        )
        if not resp.ok:
            return {}
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += len(batch)

    prior: dict = {}
    for row in rows:
        item_id = row.get("item_id")
        if not item_id:
            continue
        prior[item_id] = {
            "id": item_id,
            "brand": row.get("brand") or "",
            "modelOrSku": row.get("model_or_sku") or "",
            "productType": row.get("product_type") or "",
            "searchQuery": row.get("search_query") or "",
            "condition": row.get("condition") or "",
            "productUrl": row.get("product_url") or "",
            "brandConfidence": row.get("brand_confidence") or "",
            "modelConfidence": row.get("model_confidence") or "",
            "quantity": row.get("quantity") or "",
            "isMixedLot": row.get("is_mixed_lot") or "",
            "conditionFlags": row.get("condition_flags") or "",
            "keyAttributes": row.get("key_attributes") or "",
            "secondaryItems": row.get("secondary_items") or "",
            "detailCategory": row.get("detail_category") or "",
            "details": row.get("details") or "",
            "detailConfidence": row.get("detail_confidence") or "",
            "enrichmentConfidence": row.get("confidence") or "",
            "enrichmentModel": row.get("model") or "",
            "enrichmentInputHash": row.get("input_hash") or "",
        }
    return prior


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
