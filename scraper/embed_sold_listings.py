#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
# ]
# ///
"""Batch Nomic embedding + hybrid re-rank of the sold-listings corpus.

SoldComps Phase 2 / RFC #290, increment 2. Two passes, both off the hourly hot
path (the two ~550 MB Nomic models load here, not in the scrape):

  1. **embed** — embed each new ``sold_listings`` row into the shared 768-dim
     Nomic space (``sold_listing_embeddings``), reusing the #165 stack via
     ``embed_nomic.embed_items``. Each listing becomes a pseudo-item
     ``{id, title, description, images}`` so the encoding (fused text + thumbnail,
     ``search_document:`` prefix, mean-pool + renormalise) is identical to lots.
     The text folds in the listing's title + condition into the embedded text.
     Incremental
     — only listings not yet embedded.

  2. **rerank** — for each active auction, call the ``match_sold_listings`` RPC
     (the lot's own ``nomic_embeddings`` vector vs each listing's, cosine) and
     write the top-K hybrid matches back into ``ebay_comp_snapshots`` tagged
     ``source_query='visual'`` (D2 option a: the ``public_auction_comps`` view and
     the UI are unchanged; the better comps simply appear).

Gated on Supabase being configured; a true no-op otherwise. Needs the same deps
as embed_nomic (sentence-transformers, transformers==4.49.0, torchvision, pillow,
einops) plus requests.
"""

import argparse
import json
import sys
from datetime import UTC, datetime
from functools import partial

from config import EmbeddingSettings as _EmbedCfg
from supabase_comps import (
    WRITE_TIMEOUT,
    _request_with_retry,
    append_ebay_comp_snapshots,
    resolve_credentials,
)

EMBEDDING_TABLE = "sold_listing_embeddings"
CORPUS_TABLE = "sold_listings"
READ_PAGE_SIZE = 1000

# Hybrid-match thresholds for the re-rank writeback. match_count mirrors the
# curated comps' top-3; min_sim is the quality floor for a hybrid-confident comp.
# Internal tuning parameters — adjust in code with tests, not at runtime.
_RERANK_MATCH_COUNT = 3
_RERANK_MIN_SIM = 0.80
_HIGH_SIM = 0.85


def listing_to_item(row: dict) -> dict:
    """Map a ``sold_listings`` row to an embed_nomic pseudo-item.

    Uses only semantically useful normalized columns — condition is the one
    meaningful text field beyond the title (the SoldComps API carries no
    subtitle or item specifics). Avoids dumping raw_json into the embedding,
    which pulled in seller names, feedback scores, shipping strings, and eBay
    category breadcrumbs as noise.

    Image: prefers the higher-resolution ``full_res_thumbnail_url`` when
    available so the hybrid embedding captures more detail.
    """
    description = (row.get("condition") or "").strip()
    image = row.get("full_res_thumbnail_url") or row.get("thumbnail_url") or ""
    return {
        "id": row["ebay_item_id"],
        "title": row.get("title") or "",
        "description": description,
        "images": [image] if image else [],
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
    """Paginate a PostgREST GET via Range headers, retrying transient failures.

    ``order=ebay_item_id`` is injected unconditionally so every multi-page read
    sees a stable sort order — without it PostgreSQL can return rows in any order
    across pages, causing skips or duplicates at page boundaries.
    """
    rows: list[dict] = []
    offset = 0
    # Merge a stable sort key; caller params take precedence on everything else.
    params = {"order": "ebay_item_id", **params}
    while True:
        page_headers = {**headers, "Range": f"{offset}-{offset + READ_PAGE_SIZE - 1}"}
        resp = _request_with_retry(
            partial(
                session.get,
                endpoint,
                headers=page_headers,
                params=params,
                timeout=(10, 90),
            ),
            "sold-listing-embeddings read",
        )
        batch = resp.json() or []
        rows.extend(batch)
        if len(batch) < READ_PAGE_SIZE:
            return rows
        offset += READ_PAGE_SIZE


def fetch_listings_by_ids(session, url: str, key: str, item_ids: list[str]) -> list[dict]:
    """Fetch specific sold_listings rows by ebay_item_id (force-embed by ID)."""
    base = url.rstrip("/")
    rows = _get_all(
        session,
        f"{base}/rest/v1/{CORPUS_TABLE}",
        _headers(key),
        {
            "select": "ebay_item_id,title,condition,thumbnail_url,full_res_thumbnail_url",
            "ebay_item_id": f"in.({','.join(item_ids)})",
        },
    )
    return [r for r in rows if r.get("ebay_item_id")]


def fetch_unembedded_listings(session, url: str, key: str) -> list[dict]:
    """Return corpus rows that have no embedding yet (incremental)."""
    base = url.rstrip("/")
    embedded = {
        r["ebay_item_id"]
        for r in _get_all(
            session,
            f"{base}/rest/v1/{EMBEDDING_TABLE}",
            _headers(key),
            {"select": "ebay_item_id"},
        )
        if r.get("ebay_item_id")
    }
    corpus = _get_all(
        session,
        f"{base}/rest/v1/{CORPUS_TABLE}",
        _headers(key),
        {"select": "ebay_item_id,title,condition,thumbnail_url,full_res_thumbnail_url"},
    )
    return [
        r for r in corpus if r.get("ebay_item_id") and r["ebay_item_id"] not in embedded
    ]


def upsert_listing_embeddings(
    embeddings, ids, n_images_used, url, key, session, batch_size=100
) -> int:
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
        resp = session.post(
            endpoint, headers=headers, data=json.dumps(batch), timeout=120
        )
        if resp.status_code < 400:
            return len(batch)
        # HNSW index pressure → statement timeout (57014); split and retry.
        is_timeout = resp.status_code in (500, 503, 504) and (
            "57014" in resp.text or "timeout" in resp.text.lower()
        )
        if is_timeout and len(batch) > 1:
            mid = len(batch) // 2
            return _post(batch[:mid]) + _post(batch[mid:])
        raise RuntimeError(
            f"sold-listing embeddings upsert failed ({resp.status_code}): {resp.text[:300]}"
        )

    written = 0
    for start in range(0, len(rows), batch_size):
        written += _post(rows[start : start + batch_size])
    return written


_cfg = _EmbedCfg()
_EMBED_LIMIT = _cfg.sold_embed_limit
_EMBED_CHUNK = _cfg.sold_embed_chunk


def embed_corpus(session=None, item_ids: list[str] | None = None) -> int:
    """Embed corpus listings in small committed chunks.

    If item_ids is given, embeds exactly those listings (force-mode, ignores the
    incremental filter — useful for targeted re-embedding after cleanup).
    Otherwise, fetches all unembedded listings, caps to _EMBED_LIMIT per run,
    and processes in _EMBED_CHUNK sub-batches so a preempted runner preserves
    partial progress.
    """
    url, key = resolve_credentials()
    if not url or not key:
        print("[sold-embed] Supabase unconfigured — skipping")
        return 0
    if session is None:
        import requests

        session = requests.Session()

    if item_ids:
        rows = fetch_listings_by_ids(session, url, key, item_ids)
        if not rows:
            print(f"[sold-embed] none of the {len(item_ids)} requested IDs found in corpus")
            return 0
        print(f"[sold-embed] targeted: {len(rows)}/{len(item_ids)} listings fetched by ID")
    else:
        all_rows = fetch_unembedded_listings(session, url, key)
        if not all_rows:
            print("[sold-embed] no new listings to embed")
            return 0
        rows = all_rows[:_EMBED_LIMIT]
        if len(all_rows) > _EMBED_LIMIT:
            print(
                f"[sold-embed] {len(all_rows)} unembedded — processing {_EMBED_LIMIT} "
                f"this run (set GOONERS_SOLD_EMBED_LIMIT to change)"
            )

    n_with_images = sum(
        1 for r in rows if r.get("full_res_thumbnail_url") or r.get("thumbnail_url")
    )
    print(f"[sold-embed] {len(rows)} to embed ({n_with_images} with images)")

    from embed_nomic import embed_items

    total = 0
    for start in range(0, len(rows), _EMBED_CHUNK):
        chunk = rows[start : start + _EMBED_CHUNK]
        items = [listing_to_item(r) for r in chunk]
        n_img = sum(1 for it in items if it.get("images"))
        print(
            f"[sold-embed] chunk {start // _EMBED_CHUNK + 1}/"
            f"{(len(rows) + _EMBED_CHUNK - 1) // _EMBED_CHUNK}: "
            f"{len(chunk)} listings ({n_img} with images)..."
        )
        embeddings, ids, n_images_used = embed_items(items, session=session)
        written = upsert_listing_embeddings(
            embeddings, ids, n_images_used, url, key, session
        )
        total += written
        print(f"[sold-embed]   → committed {written} embeddings ({total} total so far)")

    if not item_ids:
        remaining = len(all_rows) - len(rows)
        if remaining:
            print(f"[sold-embed] {remaining} listings still unembedded — re-run to continue")
    print(f"[sold-embed] done: {total} listing embeddings → {EMBEDDING_TABLE}")
    return total


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _keyword_item_ids(session, url: str, key: str, safe_id: str) -> set[str]:
    """Item IDs in this auction that have at least one keyword comp (specific/broad)."""
    rows = _get_all(
        session,
        f"{url.rstrip('/')}/rest/v1/ebay_comp_snapshots",
        _headers(key),
        {
            "select": "item_id",
            "auction_safe_id": f"eq.{safe_id}",
            "source_query": "in.(specific,broad)",
        },
    )
    return {r["item_id"] for r in rows if r.get("item_id")}


def _enriched_item_ids(session, url: str, key: str, safe_id: str) -> set[str]:
    """Item IDs with medium/high enrichment confidence (brand/artist identified)."""
    rows = _get_all(
        session,
        f"{url.rstrip('/')}/rest/v1/lot_enrichment",
        _headers(key),
        {
            "select": "item_id",
            "auction_safe_id": f"eq.{safe_id}",
            "confidence": "in.(medium,high)",
        },
    )
    return {r["item_id"] for r in rows if r.get("item_id")}


def rerank_rows_for_auction(
    matches: list[dict], safe_id: str, fetched_at: str,
    skip_item_ids: set[str] | None = None,
) -> list[dict]:
    """Shape ``match_sold_listings`` RPC rows into ebay_comp_snapshots rows.

    Tagged ``source_query='visual'`` (the hybrid path) so they slot into the existing
    public_auction_comps view as a distinct, hybrid-ranked comp set. The
    similarity is bucketed into the text match_confidence the UI already renders.

    skip_item_ids: lots to exclude — those where keyword comps exist AND enrichment
    identified a brand/artist (keyword pipeline owns those; the hybrid path is redundant).
    """
    rows = []
    for match in matches or []:
        item_id = match.get("item_id")
        if not item_id or not match.get("item_web_url"):
            continue
        if skip_item_ids and str(item_id) in skip_item_ids:
            continue
        sim = match.get("similarity") or 0
        rows.append(
            {
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
            }
        )
    return rows


def rerank_auction(
    safe_id: str, url: str, key: str, session, fetched_at: str,
    skip_item_ids: set[str] | None = None,
) -> int:
    """Call match_sold_listings for one auction; write the comps back."""
    endpoint = f"{url.rstrip('/')}/rest/v1/rpc/match_sold_listings"
    resp = _request_with_retry(
        partial(
            session.post,
            endpoint,
            headers=_headers(key, write=True),
            data=json.dumps(
                {
                    "active_auction": safe_id,
                    "match_count": _RERANK_MATCH_COUNT,
                    "min_sim": _RERANK_MIN_SIM,
                }
            ),
            timeout=WRITE_TIMEOUT,
        ),
        f"match_sold_listings({safe_id})",
    )
    rows = rerank_rows_for_auction(
        resp.json() or [], safe_id, fetched_at, skip_item_ids=skip_item_ids
    )
    if not rows:
        return 0
    return append_ebay_comp_snapshots(rows, url=url, key=key, session=session)


def rerank_all_active(session=None) -> int:
    """Re-rank + write hybrid comps for every active auction. Returns rows written."""
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
    skipped_total = 0
    for safe_id in safe_ids:
        try:
            # Mixture-of-experts gate: skip hybrid for lots where the keyword
            # pipeline already found something AND enrichment identified a
            # brand/artist (those lots get better comps from exact-phrase search).
            kw_ids = _keyword_item_ids(session, url, key, safe_id)
            en_ids = _enriched_item_ids(session, url, key, safe_id)
            skip = kw_ids & en_ids
            if skip:
                skipped_total += len(skip)
            written = rerank_auction(
                safe_id, url, key, session, fetched_at,
                skip_item_ids=skip or None,
            )
            total += written
        except RuntimeError as exc:
            print(f"[sold-rerank] {safe_id}: {exc}")
    print(
        f"[sold-rerank] wrote {total} hybrid comp row(s) across {len(safe_ids)} auction(s)"
        + (f" (skipped {skipped_total} enriched lots with keyword comps)" if skipped_total else "")
    )
    return total


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Embed + hybrid re-rank the sold-listings corpus"
    )
    parser.add_argument(
        "--step",
        choices=["embed", "rerank", "all"],
        default="all",
        help="embed = generate listing embeddings; rerank = write hybrid comps; all = both (default).",
    )
    parser.add_argument(
        "--item-ids",
        help="Comma-separated ebay_item_ids to embed (targeted mode — skips the unembedded-only filter).",
    )
    args = parser.parse_args(argv or sys.argv[1:])
    item_ids = [i.strip() for i in args.item_ids.split(",") if i.strip()] if args.item_ids else None
    if args.step in ("embed", "all"):
        embed_corpus(item_ids=item_ids)
    if args.step in ("rerank", "all"):
        rerank_all_active()
    return 0


if __name__ == "__main__":
    sys.exit(main())
