"""Supabase (PostgREST) sink for the raw eBay sold-listings corpus — issue #293.

SoldComps Phase 2, part 1. Phase 1 (#283) requests up to ``count`` (40) sold
listings per API call but the curated ``ebay_comp_snapshots`` keeps only the top
~3 per query. This module persists the **full** candidate set into the
``sold_listings`` table (migration 0023), deduped by ``ebay_item_id``, so the
listings we already pay for become a reusable corpus for the Nomic visual
re-rank (part 2) and corpus-first reuse (part 3).

Companion to ``supabase_comps.py``/``supabase_enrichment.py``: writes use the
secret key (``SUPABASE_SECRET_KEY``, bypasses RLS) and upsert on the
``ebay_item_id`` primary key (merge-duplicates), so re-encountering a listing
refreshes its attributes + ``last_seen_at`` while preserving ``first_seen_at``.

**Opt-in.** Capture and write are gated on ``GOONERS_SOLD_LISTINGS_CORPUS=1`` so
the existing comp fetch (and scheduled runs) behave unchanged until the corpus
is validated — the same posture as enrichment/Nomic embeddings.
"""

import json
import os
from functools import partial

# Reuse the comp sink's credential resolution, JSON coercion, and retry loop so
# the two sinks stay byte-for-byte consistent on PostgREST mechanics.
from supabase_comps import (
    DEFAULT_BATCH_SIZE,
    WRITE_TIMEOUT,
    _request_with_retry,
    json_safe,
    resolve_credentials,
)

SOLD_LISTINGS_TABLE = "sold_listings"

# Columns written per row, mapping the SoldComps candidate dict (left, as built
# by ``ebay_fetch.soldcomps_item_match``) onto the `sold_listings` table column
# (right). `seen_count`/`first_seen_at` are deliberately omitted so the table
# defaults fill them on insert and merge-duplicates preserves them on update
# (first values win for the immutable listing); `last_seen_at` IS sent so each
# re-encounter refreshes it. `raw_json` (the full provider item) is sent as-is
# into the jsonb column. Caller stamps `category_id`, `source_query`,
# `last_seen_at`, and `raw_json` with the lot/query context.
_COLUMN_FROM_CANDIDATE = {
    "ebay_item_id": "ebay_item_id",
    "title": "title",
    "sold_price": "price_value",
    "sold_currency": "price_currency",
    "sold_date": "sold_date",
    "sold_date_label": "sold_date_label",
    "category_id": "category_id",
    "condition": "condition",
    "thumbnail_url": "thumbnail_url",
    "item_web_url": "item_web_url",
    "source_query": "source_query",
    "last_seen_at": "last_seen_at",
}
SOLD_LISTING_COLUMNS = (*_COLUMN_FROM_CANDIDATE.keys(), "raw_json")


def sold_listings_corpus_enabled() -> bool:
    """Whether to capture + persist the raw sold-listings corpus (opt-in)."""
    return os.environ.get("GOONERS_SOLD_LISTINGS_CORPUS", "").strip() in {
        "1",
        "true",
        "True",
    }


def build_sold_listing_rows(records: list[dict]) -> list[dict]:
    """Project candidate-listing dicts onto the table columns, deduped by id.

    Each input is a SoldComps match dict (``ebay_item_id``/``price_value``/… as
    built by ``ebay_fetch.soldcomps_item_match``) with the lot context
    (``category_id``, ``source_query``, ``last_seen_at``, ``raw_json``) merged on
    by the caller. Listings without an ``ebay_item_id`` or ``item_web_url`` are
    dropped; duplicates within the batch collapse to the last occurrence
    (PostgREST upsert can't touch the same conflict key twice in one request).
    """
    by_id: dict[str, dict] = {}
    for record in records or []:
        ebay_item_id = str(record.get("ebay_item_id") or "").strip()
        if not ebay_item_id or not record.get("item_web_url"):
            continue
        row = {
            column: json_safe(record.get(source))
            for column, source in _COLUMN_FROM_CANDIDATE.items()
        }
        # raw_json is already JSON-native (it came from response.json()); store it
        # verbatim into the jsonb column rather than coercing it.
        row["raw_json"] = record.get("raw_json")
        by_id[ebay_item_id] = row
    return list(by_id.values())


def upsert_sold_listings(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Upsert ``sold_listings`` rows (merge on the ``ebay_item_id`` key).

    Retries transient failures with backoff (via the shared comp retry loop);
    raises RuntimeError on missing credentials or a permanent failure."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError(
            "SUPABASE_URL is required to write sold listings to Supabase"
        )
    if not key:
        raise RuntimeError(
            "SUPABASE_SECRET_KEY is required to write sold listings to Supabase"
        )

    from http_client import supabase_session

    session = session or supabase_session("sold_listings")
    endpoint = f"{url.rstrip('/')}/rest/v1/{SOLD_LISTINGS_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        # Upsert on the ebay_item_id primary key.
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        _request_with_retry(
            partial(
                session.post,
                endpoint,
                headers=headers,
                data=json.dumps(batch),
                timeout=WRITE_TIMEOUT,
            ),
            "Supabase sold-listings upsert",
        )
        written += len(batch)
    return written


def maybe_export_sold_listings(records: list[dict], session=None) -> int:
    """Inline post-fetch hook: persist the corpus when enabled + configured.

    Resilient by design (the comp read model is the primary deliverable):
      - Feature off (``GOONERS_SOLD_LISTINGS_CORPUS`` unset) → quiet no-op.
      - URL set but no secret key → warn (likely misconfiguration), no-op.
      - No candidate listings → quiet no-op.
      - Upsert fails after retries → warn loudly, but don't raise.
    """
    if not sold_listings_corpus_enabled():
        return 0
    url, key = resolve_credentials()
    if not key:
        if url:
            print(
                "  WARNING: SUPABASE_URL is set but SUPABASE_SECRET_KEY is not — "
                "skipping sold-listings corpus write"
            )
        return 0
    rows = build_sold_listing_rows(records)
    if not rows:
        return 0
    try:
        written = upsert_sold_listings(rows, url=url, key=key, session=session)
    except RuntimeError as exc:
        print(
            f"  WARNING: failed to write {len(rows)} sold-listing(s) to Supabase: {exc}"
        )
        return 0
    print(f"  upserted {written} sold-listing(s) into the corpus")
    return written
