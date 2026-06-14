#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "beautifulsoup4",
#     "pyyaml",
#     "numpy",
# ]
# ///
"""A/B eval of comp quality across the comp-pipeline factors (RFC #290 follow-up).

Measures whether the comp-quality improvements actually surface better comps,
using a Nomic-embedding metric: cosine similarity between a lot's fused
text+image embedding and each returned sold-comp's embedding (higher = the comp
looks/reads more like the lot).

Four arms, isolating each factor (all fetch count=40 candidates):
  baseline    — bare title keyword, no filters, no enrichment, eBay default sort
  filters     — + country (domestic/ebay.com) + category_id + item_condition + recency
  enrichment  — + the LLM searchQuery as the keyword (instead of the title)
  rerank      — enrichment's candidates, re-ranked by embedding similarity

Note: the embedding metric is fair for baseline/filters/enrichment (those queries
don't optimise it); the rerank arm *selects* for it, so its lift is partly by
construction — read it as "how much headroom the candidate pool had", not a free win.

Stores every (lot, arm, candidate) row (with similarity + rank) to the
`comp_quality_eval` table, then prints per-arm mean top-3 similarity.

  uv run --with requests --with sentence-transformers --with 'transformers==4.49.0' \\
    --with torchvision --with pillow --with einops --with numpy \\
    python ab_comp_quality.py --limit 100
"""

import argparse
import json
import os
import sys
import time
import uuid
from functools import partial

import numpy as np
import requests

import ebay_query as eq
from embed_sold_listings import listing_to_item
from supabase_comps import _request_with_retry, resolve_credentials

EVAL_TABLE = "comp_quality_eval"
EMB_TABLE = "sold_listing_embeddings"
NOMIC_TABLE = "nomic_embeddings"
ENRICH_TABLE = "lot_enrichment"
LOTS_TABLE = "lots"
_UA = "gooners-ab-eval/1.0 (+scraper)"
_TOP_K = 3
_COUNT = 40


def _headers(key, write=False):
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": _UA}
    if write:
        h["Content-Type"] = "application/json"
        h["Prefer"] = "return=minimal"
    return h


def _get(session, url, key, table, params):
    resp = _request_with_retry(
        partial(session.get, f"{url.rstrip('/')}/rest/v1/{table}", headers=_headers(key), params=params, timeout=(10, 90)),
        f"GET {table}",
    )
    return resp.json() or []


def _parse_vec(value):
    # pgvector renders as "[f1,f2,...]" — valid JSON.
    return np.asarray(json.loads(value), dtype=np.float32)


def load_sample(session, url, key, n):
    """Sample n lots that have confident enrichment (with a searchQuery) AND a
    Nomic embedding — so every arm is distinct and the metric is computable."""
    enr = _get(session, url, key, ENRICH_TABLE, {
        "select": "auction_safe_id,item_id,brand,model_or_sku,search_query,condition,title,category,raw_category",
        "confidence": "in.(medium,high)",
        "limit": str(n * 4),
    })
    enr = [e for e in enr if (e.get("search_query") or "").strip()]
    if not enr:
        return []
    ids = list({e["item_id"] for e in enr})[: n * 3]
    in_clause = "in.(" + ",".join(f'"{i}"' for i in ids) + ")"
    embs = _get(session, url, key, NOMIC_TABLE, {"select": "auction_safe_id,item_id,embedding", "item_id": in_clause})
    emb_by = {(e["auction_safe_id"], e["item_id"]): _parse_vec(e["embedding"]) for e in embs}
    lots = _get(session, url, key, LOTS_TABLE, {"select": "auction_safe_id,item_id,title,description", "item_id": in_clause})
    desc_by = {(row["auction_safe_id"], row["item_id"]): row for row in lots}

    sample = []
    for e in enr:
        key_t = (e["auction_safe_id"], e["item_id"])
        if key_t not in emb_by:
            continue
        lot = desc_by.get(key_t, {})
        sample.append({
            "auctionSafeId": e["auction_safe_id"],
            "id": e["item_id"],
            "title": lot.get("title") or e.get("title") or "",
            "description": lot.get("description") or "",
            "category": e.get("category") or "",
            "rawCategory": e.get("raw_category") or "",
            "brand": e.get("brand") or "",
            "modelOrSku": e.get("model_or_sku") or "",
            "searchQuery": e.get("search_query") or "",
            "condition": e.get("condition") or "",
            "enrichmentConfidence": "high",
            "_embedding": emb_by[key_t],
        })
        if len(sample) >= n:
            break
    return sample


def arm_search(item, arm):
    title_q = eq.item_exact_phrase(item) or " ".join(eq.meaningful_tokens(eq.compact_item_text(item))[:5])
    enr_q = eq.enriched_exact_phrase(item) or title_q
    filt = {"count": _COUNT, "sort_order": "endedRecently", "ebay_site": "ebay.com", "item_location": "domestic"}
    cat, cond = eq.ebay_category_id(item), eq.ebay_item_condition(item)
    if cat and cat != "0":
        filt["category_id"] = cat
    if cond:
        filt["item_condition"] = cond
    if arm == "baseline":
        return {"kind": "baseline", "query": title_q, "count": _COUNT}
    if arm == "filters":
        return {"kind": "filters", "query": title_q, **filt}
    return {"kind": arm, "query": enr_q, **filt}  # enrichment / rerank share the query


def candidate_vectors(session, url, key, candidates):
    """Embedding per ebay_item_id: reuse sold_listing_embeddings, embed the rest."""
    by_id = {c["ebay_item_id"]: c for c in candidates if c.get("ebay_item_id") and c.get("thumbnail_url")}
    vecs = {}
    ids = list(by_id)
    for start in range(0, len(ids), 100):
        chunk = ids[start:start + 100]
        in_clause = "in.(" + ",".join(f'"{i}"' for i in chunk) + ")"
        rows = _get(session, url, key, EMB_TABLE, {"select": "ebay_item_id,embedding", "ebay_item_id": in_clause})
        for r in rows:
            vecs[r["ebay_item_id"]] = _parse_vec(r["embedding"])
    missing = [by_id[i] for i in ids if i not in vecs]
    if missing:
        from embed_nomic import embed_items
        items = [listing_to_item(c) for c in missing]
        embs, eids, _ = embed_items(items, session=session)
        for eid, vec in zip(eids, embs):
            vecs[str(eid)] = np.asarray(vec, dtype=np.float32)
    return vecs


def _cos(a, b):
    return float(np.dot(a, b))  # both L2-normalised


def main(argv=None):
    parser = argparse.ArgumentParser(description="A/B comp-quality eval (Nomic similarity)")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--sleep", type=float, default=1.3)
    args = parser.parse_args(argv or sys.argv[1:])

    url, key = resolve_credentials()
    if not url or not key:
        print("Supabase + SUPABASE_SECRET_KEY required")
        return 1
    api_key = os.environ.get("SOLDCOMPS_API_KEY")
    if not api_key:
        print("SOLDCOMPS_API_KEY required")
        return 1

    session = requests.Session()
    run_id = uuid.uuid4().hex[:12]
    print(f"AB run {run_id}: loading sample...")
    sample = load_sample(session, url, key, args.limit)
    print(f"  {len(sample)} lots with enrichment + embedding")

    from ebay_fetch import soldcomps_sold_matches
    arm_sims = {a: [] for a in ("baseline", "filters", "enrichment", "rerank")}
    eval_rows = []

    for n, item in enumerate(sample, 1):
        lot_emb = item["_embedding"]
        # Fetch the three distinct query arms (rerank reuses enrichment's pool).
        fetched = {}
        for arm in ("baseline", "filters", "enrichment"):
            result = soldcomps_sold_matches(session, arm_search(item, arm), api_key=api_key, max_matches=_COUNT)
            fetched[arm] = (result or {}).get("all_candidates") or []
            if args.sleep:
                time.sleep(args.sleep)

        # Embed every unique candidate across arms (reuse corpus where possible).
        all_cands = [c for arm in fetched.values() for c in arm]
        vecs = candidate_vectors(session, url, key, all_cands)

        def scored(cands):
            out = []
            for c in cands:
                v = vecs.get(c.get("ebay_item_id"))
                if v is not None:
                    out.append((c, _cos(lot_emb, v)))
            return out

        for arm in ("baseline", "filters", "enrichment"):
            ranked = scored(fetched[arm])  # native order (recency / default)
            for rank, (c, sim) in enumerate(ranked, 1):
                eval_rows.append((run_id, item["auctionSafeId"], item["id"], arm, c.get("ebay_item_id"),
                                  rank, sim, arm_search(item, arm)["query"], c.get("title"),
                                  c.get("price_value"), c.get("sold_date")))
            top = [s for _, s in ranked[:_TOP_K]]
            if top:
                arm_sims[arm].append(float(np.mean(top)))

        # rerank: enrichment pool, ordered by similarity.
        rr = sorted(scored(fetched["enrichment"]), key=lambda x: x[1], reverse=True)
        for rank, (c, sim) in enumerate(rr, 1):
            eval_rows.append((run_id, item["auctionSafeId"], item["id"], "rerank", c.get("ebay_item_id"),
                              rank, sim, arm_search(item, "enrichment")["query"], c.get("title"),
                              c.get("price_value"), c.get("sold_date")))
        rtop = [s for _, s in rr[:_TOP_K]]
        if rtop:
            arm_sims["rerank"].append(float(np.mean(rtop)))

        if n % 10 == 0:
            print(f"  [{n}/{len(sample)}] " + " ".join(
                f"{a}={np.mean(v):.3f}" for a, v in arm_sims.items() if v))

    # Persist all rows.
    cols = ("run_id", "auction_safe_id", "item_id", "arm", "ebay_item_id", "rank",
            "similarity", "query", "title", "sold_price", "sold_date")
    payload = [dict(zip(cols, r)) for r in eval_rows]
    endpoint = f"{url.rstrip('/')}/rest/v1/{EVAL_TABLE}"
    for start in range(0, len(payload), 500):
        _request_with_retry(
            partial(session.post, endpoint, headers=_headers(key, write=True),
                    data=json.dumps(payload[start:start + 500]), timeout=(10, 60)),
            "store eval rows",
        )

    print(f"\n=== AB run {run_id}: mean top-{_TOP_K} lot↔comp similarity ===")
    base = np.mean(arm_sims["baseline"]) if arm_sims["baseline"] else float("nan")
    for arm in ("baseline", "filters", "enrichment", "rerank"):
        vals = arm_sims[arm]
        if vals:
            m = np.mean(vals)
            delta = "" if arm == "baseline" else f"  ({(m - base):+.3f} vs baseline)"
            print(f"  {arm:11} {m:.4f}  (n={len(vals)}){delta}")
    print(f"\nStored {len(payload)} rows to {EVAL_TABLE} (run_id={run_id})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
