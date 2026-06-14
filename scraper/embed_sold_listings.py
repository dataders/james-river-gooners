#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
# ]
# ///
"""Batch Nomic embedding + visual re-rank of the sold-listings corpus.

SoldComps Phase 2 / RFC #290, increment 2. Two passes, both off the hourly hot
path (the two ~550 MB Nomic models load here, not in the scrape):

  1. **embed** — embed each new ``sold_listings`` row into the shared 768-dim
     Nomic space (``sold_listing_embeddings``), reusing the #165 stack via
     ``embed_nomic.embed_items``. Each listing becomes a pseudo-item
     ``{id, title, description, images}`` so the encoding (fused text + thumbnail,
     ``search_document:`` prefix, mean-pool + renormalise) is identical to lots.
     The text folds in the listing's title + condition + all the text in its
     ``raw_json`` (per the D2 decision: embed more than the thumbnail). Incremental
     — only listings not yet embedded.

  2. **rerank** — for each active auction, call the ``match_sold_listings`` RPC
     (the lot's own ``nomic_embeddings`` vector vs each listing's, cosine) and
     write the visually-best K back into ``ebay_comp_snapshots`` tagged
     ``source_query='visual'`` (D2 option a: the ``public_auction_comps`` view and
     the UI are unchanged; the better comps simply appear).

Gated on Supabase being configured; a true no-op otherwise. Needs the same deps
as embed_nomic (sentence-transformers, transformers==4.49.0, torchvision, pillow,
einops) plus requests.
"""

import argparse
import json
import os
import sys
from datetime import datetime, UTC
from functools import partial

from supabase_comps import (
    WRITE_TIMEOUT,
    _request_with_retry,
    append_ebay_comp_snapshots,
    resolve_credentials,
)

EMBEDDING_TABLE = "sold_listing_embeddings"
CORPUS_TABLE = "sold_listings"
READ_PAGE_SIZE = 1000

# Visual-match thresholds for the re-rank writeback (env-tunable). match_count
# mirrors the curated comps' top-3; min_sim is the quality floor for a listing to
# be shown as a visually-confident comp.
_RERANK_MATCH_COUNT = int(os.environ.get("GOONERS_SOLD_RERANK_COUNT", "3"))
_RERANK_MIN_SIM = float(os.environ.get("GOONERS_SOLD_RERANK_MIN_SIM", "0.80"))
# A listing this similar reads as a "high"-confidence visual match (vs medium).
_HIGH_SIM = float(os.environ.get("GOONERS_SOLD_RERANK_HIGH_SIM", "0.85"))


def listing_to_item(row: dict) -> dict:
    """Map a ``sold_listings`` row to an embed_nomic pseudo-item.

    `description` folds the listing's condition and every non-URL string in its
    `raw_json` (subtitle, condition, etc.) into the embedded text, so the vector
    captures more than the title — per the D2 decision to embed the JSON text,
    not just the thumbnail. The thumbnail is the lone image.
    """
    raw = row.get("raw_json") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    text_bits = [row.get("condition") or ""]
    if isinstance(raw, dict):
        for value in raw.values():
            if isinstance(value, str) and value and not value.startswith("http"):
                text_bits.append(value)
    description = " ".join(bit for bit in text_bits if bit).strip()[:2000]
    thumbnail = row.get("thumbnail_url")
    return {
        "id": row["ebay_item_id"],
        "title": row.get("title") or "",
        "description": description,
        "images": [thumbnail] if thumbnail else [],
    }


def _headers(key: str, *, write: bool = False) -> dict:
    from embed_nomic import _SUPABASE_UA

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        # Supabase rejects the secret key from a browser-looking UA.
        "User-Agent": _SUPABASE_UA,
    }
    if write:
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    return headers


def _get_all(session, endpoint: str, headers: dict, params: dict) -> list[dict]:
    """Paginate a PostgREST GET via Range headers, retrying transient failures."""
    rows: list[dict] = []
    offset = 0
    while True:
        page_headers = {**headers, "Range": f"{offset}-{offset + READ_PAGE_SIZE - 1}"}
        resp = _request_with_retry(
            partial(session.get, endpoint, headers=page_headers, params=params, timeout=(10, 90)),
            "sold-listing-embeddings read",
        )
        batch = resp.json() or []
        rows.extend(batch)
        if len(batch) < READ_PAGE_SIZE:
            return rows
        offset += READ_PAGE_SIZE


def fetch_unembedded_listings(session, url: str, key: str) -> list[dict]:
    """Return corpus rows that have no embedding yet (incremental)."""
    base = url.rstrip("/")
    embedded = {
        r["ebay_item_id"]
        for r in _get_all(
            session, f"{base}/rest/v1/{EMBEDDING_TABLE}", _headers(key),
            {"select": "ebay_item_id"},
        )
        if r.get("ebay_item_id")
    }
    corpus = _get_all(
        session, f"{base}/rest/v1/{CORPUS_TABLE}", _headers(key),
        {"select": "ebay_item_id,title,condition,thumbnail_url,raw_json"},
    )
    return [r for r in corpus if r.get("ebay_item_id") and r["ebay_item_id"] not in embedded]


def upsert_listing_embeddings(embeddings, ids, n_images_used, url, key, session, batch_size=100) -> int:
    """Upsert vectors into ``sold_listing_embeddings`` (keyed ebay_item_id)."""
    from embed_nomic import NOMIC_TEXT_MODEL, NOMIC_VISION_MODEL, _vec_to_pg

    rows = [
        {
            "ebay_item_id": str(ebay_item_id),
            "embedding": _vec_to_pg(embeddings[i]),
            "n_images": n_images_used[i],
            "model": f"{NOMIC_TEXT_MODEL}+{NOMIC_VISION_MODEL}",
        }
        for i, ebay_item_id in enumerate(ids)
    ]
    endpoint = f"{url.rstrip('/')}/rest/v1/{EMBEDDING_TABLE}"
    headers = _headers(key, write=True)

    def _post(batch: list[dict]) -> int:
        resp = session.post(endpoint, headers=headers, data=json.dumps(batch), timeout=120)
        if resp.status_code < 400:
            return len(batch)
        # HNSW index pressure → statement timeout (57014); split and retry.
        is_timeout = resp.status_code in (500, 503, 504) and (
            "57014" in resp.text or "timeout" in resp.text.lower()
        )
        if is_timeout and len(batch) > 1:
            mid = len(batch) // 2
            return _post(batch[:mid]) + _post(batch[mid:])
        raise RuntimeError(f"sold-listing embeddings upsert failed ({resp.status_code}): {resp.text[:300]}")

    written = 0
    for start in range(0, len(rows), batch_size):
        written += _post(rows[start : start + batch_size])
    return written


def embed_corpus(session=None) -> int:
    """Embed every not-yet-embedded corpus listing. Returns rows written."""
    url, key = resolve_credentials()
    if not url or not key:
        print("[sold-embed] Supabase unconfigured — skipping")
        return 0
    if session is None:
        import requests
        session = requests.Session()

    rows = fetch_unembedded_listings(session, url, key)
    if not rows:
        print("[sold-embed] no new listings to embed")
        return 0

    from embed_nomic import embed_items

    items = [listing_to_item(r) for r in rows]
    print(f"[sold-embed] embedding {len(items)} new sold listings...")
    embeddings, ids, n_images_used = embed_items(items, session=session)
    written = upsert_listing_embeddings(embeddings, ids, n_images_used, url, key, session)
    print(f"[sold-embed] upserted {written} listing embeddings → {EMBEDDING_TABLE}")
    return written


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def rerank_rows_for_auction(matches: list[dict], safe_id: str, fetched_at: str) -> list[dict]:
    """Shape ``match_sold_listings`` RPC rows into ebay_comp_snapshots rows.

    Tagged ``source_query='visual'`` so they slot into the existing
    public_auction_comps view as a distinct, visually-ranked comp set. The
    similarity is bucketed into the text match_confidence the UI already renders.
    """
    rows = []
    for match in matches or []:
        item_id = match.get("item_id")
        if not item_id or not match.get("item_web_url"):
            continue
        sim = match.get("similarity") or 0
        rows.append({
            "auction_safe_id": safe_id,
            "item_id": str(item_id),
            "status": "ok",
            "query": "",
            "fetched_at": fetched_at,
            "ebay_item_id": match.get("ebay_item_id"),
            "title": match.get("title"),
            "price_value": match.get("sold_price"),
            "price_currency": "USD",
            "sold_date": match.get("sold_date"),
            "sold_date_label": match.get("sold_date_label"),
            "thumbnail_url": match.get("thumbnail_url"),
            "item_web_url": match.get("item_web_url"),
            "condition": match.get("condition"),
            "source_query": "visual",
            "match_confidence": "high" if sim >= _HIGH_SIM else "medium",
        })
    return rows


def rerank_auction(safe_id: str, url: str, key: str, session, fetched_at: str) -> int:
    """Call match_sold_listings for one auction; write the comps back."""
    endpoint = f"{url.rstrip('/')}/rest/v1/rpc/match_sold_listings"
    resp = _request_with_retry(
        partial(
            session.post, endpoint, headers=_headers(key, write=True),
            data=json.dumps({
                "active_auction": safe_id,
                "match_count": _RERANK_MATCH_COUNT,
                "min_sim": _RERANK_MIN_SIM,
            }),
            timeout=WRITE_TIMEOUT,
        ),
        f"match_sold_listings({safe_id})",
    )
    rows = rerank_rows_for_auction(resp.json() or [], safe_id, fetched_at)
    if not rows:
        return 0
    return append_ebay_comp_snapshots(rows, url=url, key=key, session=session)


def rerank_all_active(session=None) -> int:
    """Re-rank + write visual comps for every active auction. Returns rows written."""
    url, key = resolve_credentials()
    if not url or not key:
        print("[sold-rerank] Supabase unconfigured — skipping")
        return 0
    if session is None:
        import requests
        session = requests.Session()

    from supabase_lots import list_auction_safe_ids

    safe_ids = list_auction_safe_ids(url=url, key=key, archived=False)
    fetched_at = _utc_now_iso()
    total = 0
    for safe_id in safe_ids:
        try:
            total += rerank_auction(safe_id, url, key, session, fetched_at)
        except RuntimeError as exc:
            print(f"[sold-rerank] {safe_id}: {exc}")
    print(f"[sold-rerank] wrote {total} visual comp row(s) across {len(safe_ids)} auction(s)")
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Embed + visually re-rank the sold-listings corpus")
    parser.add_argument(
        "--step", choices=["embed", "rerank", "all"], default="all",
        help="embed = generate listing embeddings; rerank = write visual comps; all = both (default).",
    )
    args = parser.parse_args(argv or sys.argv[1:])
    if args.step in ("embed", "all"):
        embed_corpus()
    if args.step in ("rerank", "all"):
        rerank_all_active()
    return 0


if __name__ == "__main__":
    sys.exit(main())
