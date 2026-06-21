# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "numpy",
#     "pydantic-settings>=2,<3",
# ]
# ///
"""Supabase sink for Facebook Marketplace sold listings.

Rows are keyed by Facebook listing id. Re-encountering a sold listing refreshes
its mutable fields and last_seen_at while preserving first_seen_at via table
defaults/triggers in Postgres.
"""

from __future__ import annotations

import json
import os
from functools import partial

from supabase_comps import (
    DEFAULT_BATCH_SIZE,
    WRITE_TIMEOUT,
    _request_with_retry,
    json_safe,
    resolve_credentials,
)

FACEBOOK_SOLD_TABLE = "facebook_sold_listings"


def _normalize_vector(vec) -> list[float] | None:
    try:
        import numpy as np

        arr = np.asarray(vec, dtype="float32")
        norm = float(np.linalg.norm(arr))
        if norm <= 0:
            return None
        return (arr / norm).tolist()
    except Exception:
        return None


def _embed_text(text: str) -> list[float] | None:
    """Best-effort Nomic text embedding.

    This is gated by GOONERS_NOMIC_EMBEDDINGS so a normal scrape does not pull
    the 550 MB model stack. If deps/model load fail, caller writes embedding=NULL.
    """
    if os.environ.get("GOONERS_NOMIC_EMBEDDINGS", "").lower() not in {
        "1",
        "true",
        "yes",
        "on",
    }:
        return None
    try:
        from embed_nomic import _get_text_model

        model = _get_text_model()
        output = model.encode([f"search_document: {text or '.'}"])
        return _normalize_vector(output[0])
    except Exception as exc:
        print(f"  WARNING: Facebook sold embedding unavailable: {exc}")
        return None


def build_facebook_sold_rows(records: list[dict], *, embed: bool = False) -> list[dict]:
    """JSON-safe, de-duped rows for `facebook_sold_listings`.

    Duplicates within one batch collapse to the last occurrence because
    PostgREST upsert cannot update the same conflict key twice in one request.
    """
    by_id: dict[str, dict] = {}
    for record in records or []:
        listing_id = str(record.get("id") or "").strip()
        if not listing_id or not record.get("listing_url"):
            continue
        row = {
            "id": listing_id,
            "keyword": record.get("keyword"),
            "title": record.get("title"),
            "price_value": record.get("price_value"),
            "price_label": record.get("price_label"),
            "sold_date": record.get("sold_date"),
            "thumbnail_url": record.get("thumbnail_url"),
            "listing_url": record.get("listing_url"),
            "location": record.get("location"),
        }
        row = {k: v for k, v in row.items() if v is not None}
        if embed:
            text = " ".join(
                str(part)
                for part in (
                    row.get("title"),
                    row.get("keyword"),
                    row.get("price_label"),
                    row.get("location"),
                )
                if part
            )
            row["embedding"] = _embed_text(text)
        by_id[listing_id] = {k: json_safe(v) for k, v in row.items()}
    return list(by_id.values())


def upsert_facebook_sold_listings(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write Facebook sold listings")
    if not key:
        raise RuntimeError(
            "SUPABASE_SECRET_KEY is required to write Facebook sold listings"
        )

    if session is None:
        from http_client import supabase_session

        session = supabase_session("facebook_sold_listings")

    endpoint = f"{url.rstrip('/')}/rest/v1/{FACEBOOK_SOLD_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
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
            "Supabase Facebook sold-listings upsert",
        )
        written += len(batch)
    return written


def maybe_export_facebook_sold_listings(records: list[dict], session=None) -> int:
    url, key = resolve_credentials()
    if not key:
        if url:
            print(
                "  WARNING: SUPABASE_URL is set but SUPABASE_SECRET_KEY is not — "
                "skipping Facebook sold-listings write"
            )
        return 0
    rows = build_facebook_sold_rows(records, embed=True)
    if not rows:
        return 0
    try:
        written = upsert_facebook_sold_listings(rows, url=url, key=key, session=session)
    except RuntimeError as exc:
        print(f"  WARNING: failed to write {len(rows)} Facebook sold listing(s): {exc}")
        return 0
    print(f"  upserted {written} Facebook sold listing(s)")
    return written
