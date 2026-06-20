"""eBay sold-comp fetch via the Apify automation-lab/ebay-sold-scraper actor.

Provides the Apify backend as an alternative to the direct HTTP fetch chain.
One actor run per search query, parallelised with a thread pool; query
deduplication across items cuts the total run count significantly.

Public API used by ebay_comps.py:
  APIFY_API_URL, APIFY_ACTOR_ID, APIFY_CONCURRENCY,
  APIFY_POLL_INTERVAL, APIFY_MAX_WAIT
  apify_item_match()
  apify_start_run()
  apify_wait_for_run()
  apify_fetch_dataset()
  _apify_fetch_one_query()
  fetch_comps_apify()
"""

import time as _time_module
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from time import sleep

import env_secrets as secrets
import requests
from ebay_export import (
    DATA_DIR,
    EBAY_COMPS_DIR,
    auction_end_sort_key,
    build_public_exports,
    load_manifest_items,
    merge_comp_files,
    mirror_rows_to_warehouse,
)
from ebay_fetch import (
    canonical_ebay_item_url,
    date_from_iso,
    extract_ebay_item_id,
    price_amount,
    shipping_label,
    sold_date_label_from_iso,
)
from ebay_ledger import (
    CompLedger,
    FileCompLedger,
    supabase_comp_backend_active,
)
from ebay_query import build_ebay_sold_searches
from ebay_snapshot import comp_rows_for_item
from ebay_util import text_value, utc_now_text

# ── Constants ─────────────────────────────────────────────────────────────────

APIFY_API_URL = "https://api.apify.com/v2"
APIFY_ACTOR_ID = "automation-lab~ebay-sold-scraper"
APIFY_CONCURRENCY = 25  # parallel actor runs
APIFY_POLL_INTERVAL = 10  # seconds between status polls per run
APIFY_MAX_WAIT = 300  # 5-minute ceiling per individual run

DEFAULT_STALE_HOURS = 7 * 24


# ── Item mapping ──────────────────────────────────────────────────────────────


def apify_item_match(item: dict, source_query: str) -> dict | None:
    """Map one Apify dataset item to the same match shape as soldcomps_item_match."""
    # automation-lab/ebay-sold-scraper uses soldPrice / soldDate / url / itemId.
    # Fall back to the same aliases soldcomps_item_match uses so both actors work.
    item_web_url = canonical_ebay_item_url(
        text_value(item.get("url") or item.get("itemUrl") or item.get("itemWebUrl"))
    )
    if not item_web_url:
        return None
    title = text_value(item.get("title"))
    price_value = price_amount(
        text_value(item.get("soldPrice") or item.get("price") or item.get("priceValue"))
    )
    if not title or not price_value:
        return None
    ended_at = text_value(
        item.get("soldDate") or item.get("endedAt") or item.get("soldAt")
    )
    return {
        "ebay_item_id": (
            text_value(item.get("itemId") or item.get("ebayItemId"))
            or extract_ebay_item_id(item_web_url)
        ),
        "title": title,
        "price_value": price_value,
        "price_currency": text_value(
            item.get("soldCurrency") or item.get("currency"), "USD"
        ),
        "shipping_label": shipping_label(
            item.get("shippingCost")
            or item.get("shippingPrice")
            or item.get("shipping")
        ),
        "sold_date": date_from_iso(ended_at),
        "sold_date_label": sold_date_label_from_iso(ended_at),
        "thumbnail_url": text_value(
            item.get("thumbnail")
            or item.get("imageUrl")
            or item.get("thumbnailUrl")
            or item.get("image")
        ),
        "item_web_url": item_web_url,
        "condition": text_value(item.get("condition")),
        "source_query": source_query,
        "match_confidence": "medium",
    }


# ── Apify API helpers ─────────────────────────────────────────────────────────


def apify_start_run(
    api_key: str,
    search_queries: list[str],
    max_listings_per_search: int = 10,
    actor_id: str = APIFY_ACTOR_ID,
    timeout: int = 30,
) -> tuple[str, str]:
    """Start an Apify actor run; return (run_id, dataset_id)."""
    resp = requests.post(
        f"{APIFY_API_URL}/acts/{actor_id}/runs",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "searchQueries": search_queries,
            "maxListingsPerSearch": max_listings_per_search,
            "maxSearchPages": 1,
        },
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return data["id"], data["defaultDatasetId"]


def apify_wait_for_run(
    api_key: str,
    run_id: str,
    poll_interval: int = APIFY_POLL_INTERVAL,
    max_wait: int = APIFY_MAX_WAIT,
    timeout: int = 30,
) -> str:
    """Poll until the run finishes; return its final status string."""
    deadline = _time_module.time() + max_wait
    while _time_module.time() < deadline:
        resp = requests.get(
            f"{APIFY_API_URL}/actor-runs/{run_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )
        resp.raise_for_status()
        status = resp.json()["data"]["status"]
        if status in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            return status
        sleep(poll_interval)
    return "TIMED-OUT"


def apify_fetch_dataset(
    api_key: str,
    dataset_id: str,
    timeout: int = 60,
) -> list[dict]:
    """Fetch all items from an Apify dataset.

    The items endpoint returns a plain JSON array (not a paginated wrapper),
    so a single request is enough for the small per-query result sets we use.
    """
    resp = requests.get(
        f"{APIFY_API_URL}/datasets/{dataset_id}/items",
        headers={"Authorization": f"Bearer {api_key}"},
        params={"format": "json"},
        timeout=timeout,
    )
    resp.raise_for_status()
    body = resp.json()
    return body if isinstance(body, list) else (body.get("items") or [])


# ── Orchestration ─────────────────────────────────────────────────────────────


def _apify_fetch_one_query(
    api_key: str,
    query: str,
    max_listings: int,
) -> tuple[str, list[dict]]:
    """Run one Apify actor call for a single search query; return (query, matches).

    The automation-lab/ebay-sold-scraper actor does not echo the source keyword
    in its output items, so we run one actor per query and correlate via the
    future that called this function rather than by a field in the response.
    """
    run_id, dataset_id = apify_start_run(
        api_key, [query], max_listings_per_search=max_listings
    )
    status = apify_wait_for_run(api_key, run_id)
    if status != "SUCCEEDED":
        return query, []
    return query, apify_fetch_dataset(api_key, dataset_id)


def fetch_comps_apify(
    data_dir: Path = DATA_DIR,
    output_dir: Path = EBAY_COMPS_DIR,
    queries_per_item: int = 3,
    max_matches: int = 3,
    max_listings_per_search: int = 10,
    stale_hours: int = DEFAULT_STALE_HOURS,
    skip_attempted: bool = True,
    skip_categories: frozenset[str] | None = None,
    include_archived: bool = False,
    auction_safe_id: str | None = None,
    dry_run: bool = False,
    mirror_to_warehouse: bool | None = None,
    api_key: str | None = None,
    concurrency: int = APIFY_CONCURRENCY,
) -> dict:
    """Batch eBay comp fetch via the Apify automation-lab/ebay-sold-scraper actor.

    Runs one Apify actor per unique search query with a thread pool so we can
    map results back by query without relying on a keyword field in the output
    (the actor doesn't include one). Deduplicating queries across all items cuts
    the total run count significantly when multiple items share the same search.
    """
    api_key = api_key or secrets.apify_key()
    if not api_key:
        raise RuntimeError("APIFY_API_KEY is required for the apify backend")

    summary = {
        "items_attempted": 0,
        "queries_submitted": 0,
        "matches": 0,
        "files_written": 0,
    }

    if mirror_to_warehouse is None:
        from warehouse import should_mirror

        mirror_to_warehouse = should_mirror()

    use_supabase = bool(mirror_to_warehouse) and supabase_comp_backend_active()
    if use_supabase:
        from supabase_comps import SupabaseCompLedger

        ledger: CompLedger = SupabaseCompLedger()
    else:
        ledger = FileCompLedger(output_dir)

    known_fresh = (
        set()
        if dry_run
        else ledger.fresh_keys(stale_hours, skip_attempted=skip_attempted)
    )

    candidates = sorted(
        load_manifest_items(
            data_dir=data_dir,
            include_archived=include_archived,
            auction_safe_id=auction_safe_id,
        ),
        key=auction_end_sort_key,
    )

    # Build query → [(item, search)] mapping, deduplicating identical queries.
    # Priority order (specific first) means the first entry for a query carries
    # the highest-confidence kind label.
    query_to_entries: dict[str, list[tuple[dict, dict]]] = defaultdict(list)
    item_keys: set[str] = set()
    for item in candidates:
        safe_id = text_value(item.get("auctionSafeId"))
        item_id = text_value(item.get("id"))
        key = f"{safe_id}:{item_id}"
        if key in known_fresh:
            continue
        if skip_categories and item.get("category") in skip_categories:
            continue
        searches = build_ebay_sold_searches(item)[:queries_per_item]
        if not searches:
            continue
        item_keys.add(key)
        for search in searches:
            query_to_entries[search["query"]].append((item, search))
        summary["items_attempted"] += 1

    all_queries = list(query_to_entries.keys())
    summary["queries_submitted"] = len(all_queries)

    if dry_run:
        print(
            f"eBay comp fetch (apify dry-run): {summary['items_attempted']} items, "
            f"{len(all_queries)} unique queries, {concurrency} concurrent runs"
        )
        return summary

    # Run one Apify actor per unique query, up to `concurrency` in parallel.
    results_by_query: dict[str, list[dict]] = defaultdict(list)
    completed = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {
            pool.submit(_apify_fetch_one_query, api_key, q, max_listings_per_search): q
            for q in all_queries
        }
        for future in as_completed(futures):
            completed += 1
            if completed % 50 == 0 or completed == len(all_queries):
                print(f"  Apify: {completed}/{len(all_queries)} queries done")
            try:
                query_str, raw_items = future.result()
            except Exception as exc:
                print(f"  WARNING: query failed: {exc}")
                continue
            entries = query_to_entries.get(query_str, [])
            if not entries:
                continue
            _, first_search = entries[0]
            for raw_item in raw_items:
                match = apify_item_match(raw_item, source_query=first_search["kind"])
                if match:
                    results_by_query[query_str].append(match)

    # Build comp rows for every attempted item
    generated_at = utc_now_text()
    all_rows: list[dict] = []
    items_seen: set[str] = set()
    for item in candidates:
        safe_id = text_value(item.get("auctionSafeId"))
        item_id = text_value(item.get("id"))
        key = f"{safe_id}:{item_id}"
        if key not in item_keys or key in items_seen:
            continue
        items_seen.add(key)
        searches = build_ebay_sold_searches(item)[:queries_per_item]
        item_matches: list[dict] = []
        best_search = searches[0] if searches else {}
        for search in searches:
            q_matches = results_by_query.get(search["query"], [])
            if q_matches:
                item_matches = q_matches[:max_matches]
                best_search = search
                break
        status_val = "ok" if item_matches else "no_results"
        rows = comp_rows_for_item(
            item, best_search, item_matches, status=status_val, fetched_at=generated_at
        )
        all_rows.extend(rows)
        summary["matches"] += len(item_matches)

    if use_supabase:
        mirror_rows_to_warehouse(all_rows)
    else:
        new_exports = build_public_exports(all_rows, generated_at)
        summary["files_written"] = merge_comp_files(
            new_exports, {}, output_dir, generated_at
        )
        if mirror_to_warehouse:
            mirror_rows_to_warehouse(all_rows)

    written_msg = (
        "Supabase read model updated"
        if use_supabase
        else f"{summary['files_written']} auction files updated"
    )
    print(
        f"eBay comp fetch (apify): {summary['items_attempted']} items, "
        f"{summary['queries_submitted']} queries, {summary['matches']} matches, "
        f"{written_msg}"
    )
    return summary
