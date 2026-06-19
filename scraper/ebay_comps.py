#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "beautifulsoup4",
#     "pyarrow",
#     "pyyaml",
#     "pydantic-settings>=2,<3",
# ]
# ///
"""
Fetch eBay sold-comps into the comps read model.

Two backends, selected by the warehouse seam (scraper/warehouse.py):

* Supabase (``GOONERS_WAREHOUSE=supabase`` + credentials) is the production
  backend (issue #6). Comps are written to the ``ebay_comp_snapshots`` table,
  which is BOTH the browser read model and the scraper's own ledger: freshness
  and the shared request budget are read back from it (see SupabaseCompLedger),
  so no per-run JSON is written or committed.
* The per-auction JSON files under public/data/ebay-comps/ are the legacy /
  offline backend (no warehouse configured). They are the read model AND the
  ledger, accumulated incrementally: each run refreshes a rate-limited subset
  of items and merges results into the existing files.

Implementation is split across focused sub-modules:
  ebay_util     — shared primitives (no cross-imports)
  ebay_query    — query generation from lot metadata
  ebay_fetch    — HTTP + browser fetch chain, HTML parsing
  ebay_snapshot — comp row building, MotherDuck DDL
  ebay_export   — file read-model, manifest loading, warehouse mirror
  ebay_ledger   — CompLedger ABC + FileCompLedger + budget resolution
  ebay_apify    — Apify actor batch backend

See docs/data-architecture.md.
"""

# This module is a public-API aggregator: it re-exports names from the focused
# sub-modules above so external callers can keep importing them from
# ``ebay_comps``. Those imports are intentionally "unused" within this file, so
# silence ruff's unused-import rule for the whole module.
# ruff: noqa: F401

import argparse
import os
import random
import secrets
import sys
from pathlib import Path
from time import monotonic

import telemetry
from config import EbayCompsSettings as _CfgEbay
from corpus_reuse import CorpusReuser, corpus_first_enabled

# Apify backend — re-export for external callers and expose via the CLI.
from ebay_apify import (
    APIFY_ACTOR_ID,
    APIFY_API_URL,
    APIFY_CONCURRENCY,
    APIFY_MAX_WAIT,
    APIFY_POLL_INTERVAL,
    _apify_fetch_one_query,
    apify_fetch_dataset,
    apify_item_match,
    apify_start_run,
    apify_wait_for_run,
    fetch_comps_apify,
)

# ── Re-export the public API so external callers keep working ─────────────────
from ebay_export import (
    DATA_DIR,
    EBAY_COMPS_DIR,
    auction_end_sort_key,
    build_public_exports,
    empty_comp_export,
    fresh_comp_keys_from_files,
    load_comp_file,
    load_manifest_items,
    load_supabase_items,
    merge_comp_files,
    mirror_rows_to_warehouse,
    normalize_match_row,
    parse_fetched_at,
    requests_used_in_month,
    requests_used_today,
    write_comp_file,
)
from ebay_fetch import (
    DEFAULT_USER_AGENT,
    SOLDCOMPS_API_URL,
    USER_AGENTS,
    agent_browser_html,
    browser_sold_matches,
    extract_ebay_item_id,
    extract_usage_headers,
    fetch_sold_matches,
    html_from_browser_output,
    is_ebay_item_url,
    parse_sold_search_html,
    run_agent_browser,
    soldcomps_sold_matches,
    usage_remaining,
)
from ebay_ledger import (
    CompLedger,
    FileCompLedger,
    resolve_query_budget,
    supabase_comp_backend_active,
)
from ebay_query import (
    RESTRICTED_CATEGORIES,
    STOP_WORDS,
    build_ebay_sold_searches,
    item_exact_phrase,
)

# Keep these available for the rare callers that import the SQL templates.
from ebay_snapshot import (
    CREATE_COMP_TABLE_SQL,
    EXPORT_COLUMNS,
    INSERT_COMP_SQL,
    PUBLIC_VIEW,
    PUBLIC_VIEW_SQL,
    SNAPSHOT_TABLE,
    append_ebay_comp_snapshots,
    comp_row_values,
    comp_rows_for_item,
    ensure_comp_tables,
    insert_comp_rows,
)
from ebay_util import (
    decimal_text,
    jitter_sleep,
    json_value,
    normalize_spaces,
    text_value,
    utc_now_text,
)

DEFAULT_LIMIT = 50
DEFAULT_STALE_HOURS = 7 * 24
DEFAULT_MONTHLY_BUDGET = 50000


# ── Orchestration ─────────────────────────────────────────────────────────────


def fetch_direct(
    data_dir: Path = DATA_DIR,
    output_dir: Path = EBAY_COMPS_DIR,
    limit: int = DEFAULT_LIMIT,
    queries_per_item: int = 3,
    max_matches: int = 3,
    max_queries: int = 0,
    monthly_budget: int = 0,
    daily_pacing: bool = True,
    stale_hours: int = DEFAULT_STALE_HOURS,
    skip_attempted: bool = False,
    skip_categories: frozenset[str] | None = None,
    include_archived: bool = False,
    auction_safe_id: str | None = None,
    dry_run: bool = False,
    sleep_seconds: float = 1.0,
    mirror_to_warehouse: bool | None = None,
    provider_min_remaining: int | None = None,
    from_supabase: bool = False,
    corpus_first: bool = False,
    request_session=None,
    _rand=random.uniform,
) -> dict:
    """Fetch eBay sold comps into the comps read model.

    With Supabase configured the snapshot table is both the read model and the
    ledger: no JSON is written. Otherwise the static per-auction JSON files are
    the read model and ledger, with the warehouse an optional mirror.
    ``mirror_to_warehouse=False`` forces the file backend.
    """
    import requests

    summary = {
        "items_attempted": 0,
        "queries_attempted": 0,
        "matches": 0,
        "blocked": False,
        "files_written": 0,
        # The provider reports remaining quota on every response (X-Usage-*);
        # we stop the run when it hits the floor, the authoritative meter.
        "provider_exhausted": False,
        "provider_remaining": None,
        "sold_listings_written": 0,
        "reused_items": 0,
    }
    if limit <= 0:
        return summary

    if provider_min_remaining is None:
        provider_min_remaining = int(
            os.environ.get("GOONERS_SOLDCOMPS_MIN_REMAINING", "0") or "0"
        )

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

    # Gate the start of the run on the provider's authoritative remaining-quota
    # meter when one has been cached (issue #299), not the coarse attempt count.
    provider_remaining_cached = ledger.provider_remaining()
    cap_active, query_limit = resolve_query_budget(
        ledger,
        monthly_budget,
        max_queries,
        daily_pacing,
        provider_min_remaining=provider_min_remaining,
    )
    # Surface the gap between the coarse ledger count and the real meter so the
    # decoupling that caused #299 is observable. The ledger count read only runs
    # when telemetry is configured (it is otherwise an extra Supabase round-trip).
    if telemetry.is_telemetry_configured():
        telemetry.capture(
            "soldcomps_budget_gate",
            {
                "monthly_budget": monthly_budget,
                "ledger_requests_used_in_month": ledger.requests_used_in_month(),
                "provider_remaining": provider_remaining_cached,
                "cap_active": cap_active,
                "query_limit": query_limit,
                "gated_on_provider": provider_remaining_cached is not None,
            },
        )
    if cap_active and query_limit <= 0:
        print("eBay comp fetch: request budget exhausted for now; nothing to do.")
        if provider_remaining_cached is not None:
            print(
                "  (gated on the provider meter: "
                f"{provider_remaining_cached} remaining, "
                f"floor {provider_min_remaining})"
            )
        telemetry.flush()
        return summary

    session = request_session or requests.Session()
    generated_at = utc_now_text()
    all_rows: list[dict] = []
    attempts: dict[str, dict[str, dict]] = {}

    # Raw sold-listings corpus (#293): when enabled, accumulate the FULL
    # candidate set per query (not just the kept comps) for a one-shot upsert
    # after the run. Opt-in + Supabase-only, so the default path is unchanged.
    from supabase_sold_listings import sold_listings_corpus_enabled

    corpus_enabled = use_supabase and not dry_run and sold_listings_corpus_enabled()
    corpus_records: list[dict] = []

    # Corpus-first reuse (#290 inc 3): if the corpus already covers a lot with
    # fresh, visually-similar sold listings, use those and skip the paid API.
    # No-op unless GOONERS_CORPUS_FIRST=1 (or corpus_first=True) + Supabase.
    reuser = CorpusReuser(
        generated_at,
        session=session,
        enabled=(corpus_first or corpus_first_enabled()) and not dry_run,
    )

    # Source lots from Supabase (no local scrape needed — the read model is
    # Supabase-only in prod) or from the local parquet manifest a scrape wrote.
    loaded = (
        load_supabase_items(
            include_archived=include_archived,
            auction_safe_id=auction_safe_id,
        )
        if from_supabase
        else load_manifest_items(
            data_dir=data_dir,
            include_archived=include_archived,
            auction_safe_id=auction_safe_id,
        )
    )
    candidates = sorted(loaded, key=auction_end_sort_key)
    print(
        f"eBay comp fetch starting: {len(candidates)} lots loaded, "
        f"{len(known_fresh)} already fresh"
        + (f", budget cap {query_limit} queries" if cap_active else "")
    )
    _run_start = monotonic()

    # Leaf category scoping (Phase 2 inc 4, #329): pre-load eBay leaf
    # candidates for all distinct category groups in this run — one Supabase
    # read per group, not per lot — so the specific-tier categoryId can be
    # tightened from the coarse L1 to a matching leaf. No-op unless
    # GOONERS_EBAY_LEAF_CATEGORIES=1 + Supabase is active.
    _leaf_candidates_by_group: dict[str, list[dict]] = {}
    _best_leaf_fn = None
    if use_supabase and not dry_run:
        try:
            import ebay_taxonomy

            if ebay_taxonomy.leaf_categories_enabled():
                all_groups = {
                    str(item.get("category") or "")
                    for item in candidates
                    if item.get("category")
                }
                _leaf_candidates_by_group = ebay_taxonomy.load_leaf_candidates_by_group(
                    all_groups
                )
                _best_leaf_fn = ebay_taxonomy.best_leaf_from_candidates
        except Exception as exc:
            print(f"ebay_taxonomy: leaf category lookup failed (continuing): {exc}")

    for item in candidates:
        safe_id = text_value(item.get("auctionSafeId"))
        item_id = text_value(item.get("id"))
        if f"{safe_id}:{item_id}" in known_fresh:
            continue
        if skip_categories and item.get("category") in skip_categories:
            continue

        leaf_id = ""
        if _best_leaf_fn:
            group_candidates = _leaf_candidates_by_group.get(
                str(item.get("category") or ""), []
            )
            leaf_id = _best_leaf_fn(
                group_candidates, str(item.get("productType") or "")
            )
        searches = build_ebay_sold_searches(item, leaf_category_id=leaf_id)[
            :queries_per_item
        ]
        if not searches:
            continue

        if summary["items_attempted"] >= limit:
            break
        if cap_active and summary["queries_attempted"] >= query_limit:
            break
        summary["items_attempted"] += 1
        if summary["items_attempted"] % 100 == 0:
            _elapsed = monotonic() - _run_start
            _rate = summary["items_attempted"] / _elapsed * 60 if _elapsed > 0 else 0
            print(
                f"  … {summary['items_attempted']} items attempted, "
                f"{summary['queries_attempted']} queries, {summary['matches']} matches, "
                f"{summary['reused_items']} reused "
                f"({_elapsed:.0f}s elapsed, {_rate:.0f} items/min)"
            )
            telemetry.capture(
                "soldcomps_progress",
                {
                    "items_attempted": summary["items_attempted"],
                    "queries_attempted": summary["queries_attempted"],
                    "matches": summary["matches"],
                    "reused_items": summary["reused_items"],
                    "elapsed_seconds": round(_elapsed),
                    "items_per_minute": round(_rate, 1),
                    "provider_remaining": summary.get("provider_remaining"),
                },
            )

        # Corpus-first reuse: when the corpus already covers this lot, use those
        # comps and skip the paid API queries entirely (no-op unless enabled).
        reused = reuser.covered_comps(item)
        if reused is not None:
            all_rows.extend(reused)
            summary["matches"] += len(reused)
            summary["reused_items"] += 1
            if safe_id and item_id:
                attempts.setdefault(safe_id, {})[item_id] = {
                    "fetchedAt": generated_at,
                    "status": "reused",
                    "queries": 0,
                }
            continue

        item_status = "no_results"
        item_queries = 0
        for search in searches:
            if cap_active and summary["queries_attempted"] >= query_limit:
                break
            result = fetch_sold_matches(session, search, max_matches=max_matches)
            rows = comp_rows_for_item(
                item,
                search,
                result["matches"],
                status=result["status"],
                fetched_at=generated_at,
                warning=result.get("warning"),
            )
            summary["queries_attempted"] += 1
            item_queries += 1
            summary["matches"] += len(result["matches"])
            all_rows.extend(rows)
            if corpus_enabled:
                # Stamp each raw candidate with the corpus context: the eBay
                # categoryId we queried under (only the specific tier carries one;
                # broad/category tiers leave it empty), the query string that
                # surfaced it, and the seen time. raw_json is already attached.
                for candidate in result.get("all_candidates") or []:
                    corpus_records.append(
                        {
                            **candidate,
                            "category_id": text_value(search.get("category_id")),
                            "source_query": text_value(search.get("query")),
                            "last_seen_at": generated_at,
                        }
                    )
            remaining = result.get("provider_remaining")
            if remaining is not None:
                summary["provider_remaining"] = remaining
                if remaining <= provider_min_remaining:
                    summary["provider_exhausted"] = True
                    print(
                        "SoldComps provider quota reached "
                        f"(remaining={remaining}); stopping run."
                    )
                    break
            if result["status"] == "ok":
                item_status = "ok"
                break
            if result["status"] == "blocked":
                summary["blocked"] = True
                print(result["warning"])
                break
            if sleep_seconds > 0:
                jitter_sleep(sleep_seconds, _rand=_rand)

        if safe_id and item_id and not summary["blocked"]:
            attempts.setdefault(safe_id, {})[item_id] = {
                "fetchedAt": generated_at,
                "status": item_status,
                "queries": item_queries,
            }

        if summary["blocked"] or summary["provider_exhausted"]:
            break

    if dry_run:
        print(
            f"eBay comp fetch (dry run): {summary['items_attempted']} items, "
            f"{summary['queries_attempted']} queries planned"
        )
        return summary

    if corpus_enabled:
        from supabase_sold_listings import maybe_export_sold_listings

        summary["sold_listings_written"] = maybe_export_sold_listings(corpus_records)

    if use_supabase:
        mirror_rows_to_warehouse(all_rows)
    else:
        new_exports = build_public_exports(all_rows, generated_at)
        summary["files_written"] = merge_comp_files(
            new_exports, attempts, output_dir, generated_at
        )
        if mirror_to_warehouse:
            mirror_rows_to_warehouse(all_rows)

    written_msg = (
        "Supabase read model updated"
        if use_supabase
        else f"{summary['files_written']} auction files updated"
    )
    reused_msg = (
        f", {summary['reused_items']} reused from corpus"
        if summary["reused_items"]
        else ""
    )
    print(
        f"eBay comp fetch: {summary['items_attempted']} items, "
        f"{summary['queries_attempted']} queries, {summary['matches']} matches"
        f"{reused_msg}, {written_msg}"
    )
    if monthly_budget > 0:
        used = ledger.requests_used_in_month()
        print(
            f"Monthly request budget: {used}/{monthly_budget} used "
            f"({max(0, monthly_budget - used)} remaining)"
        )
    if summary["provider_remaining"] is not None:
        print(f"SoldComps provider quota remaining: {summary['provider_remaining']}")
        # Cache the latest reading so the next run's start gate can consult the
        # provider meter instead of the coarse attempt count (issue #299).
        # Auxiliary bookkeeping — never crash the run if the write fails.
        try:
            ledger.record_provider_remaining(summary["provider_remaining"])
        except Exception as exc:  # noqa: BLE001
            print(f"  (could not cache provider quota reading: {exc})")
    # Flush any queued telemetry before this (often short-lived) process exits.
    telemetry.flush()
    return summary


# ── CLI ────────────────────────────────────────────────────────────────────────


def parse_args(argv: list[str]) -> argparse.Namespace:
    _cfg = _CfgEbay()
    parser = argparse.ArgumentParser(
        description="Fetch eBay sold comps into the static read model"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_parser = subparsers.add_parser(
        "fetch-direct",
        help="Fetch eBay sold comps and accumulate them into JSON (warehouse optional)",
    )
    fetch_parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    fetch_parser.add_argument("--output-dir", type=Path, default=EBAY_COMPS_DIR)
    fetch_parser.add_argument(
        "--limit",
        type=int,
        default=_cfg.limit,
        help=f"Max lots to fetch comps for (env: GOONERS_EBAY_COMPS_LIMIT, default {_cfg.limit}).",
    )
    fetch_parser.add_argument("--queries-per-item", type=int, default=3)
    fetch_parser.add_argument("--max-matches", type=int, default=3)
    fetch_parser.add_argument(
        "--max-queries",
        type=int,
        default=_cfg.max_queries,
        help=f"Hard cap on SoldComps requests this run (0 = unlimited; monthly budget still applies). "
        f"env: GOONERS_EBAY_COMPS_MAX_QUERIES, default {_cfg.max_queries}.",
    )
    fetch_parser.add_argument(
        "--monthly-budget",
        type=int,
        default=_cfg.monthly_budget,
        help=f"Shared monthly request ceiling across all runs (0 = off). "
        f"env: GOONERS_EBAY_COMPS_MONTHLY_BUDGET, default {_cfg.monthly_budget}.",
    )
    fetch_parser.add_argument(
        "--no-daily-pacing",
        action="store_true",
        help="Spend the remaining monthly budget as fast as available instead "
        "of spreading it evenly across the remaining days of the month.",
    )
    fetch_parser.add_argument("--stale-hours", type=int, default=DEFAULT_STALE_HOURS)
    fetch_parser.add_argument(
        "--skip-attempted",
        action="store_true",
        help="Skip any item ever attempted (even no_results), not just fresh "
        "ones — spends budget only on never-tried items, for backfilling.",
    )
    fetch_parser.add_argument("--auction-safe-id", default=None)
    fetch_parser.add_argument(
        "--skip-categories",
        default=_cfg.skip_categories,
        help="Comma-separated broad category groups to skip entirely "
        "(e.g. 'Collectibles,Jewelry & Watches'). "
        "env: GOONERS_EBAY_COMPS_SKIP_CATEGORIES.",
    )
    fetch_parser.add_argument("--include-archived", action="store_true")
    fetch_parser.add_argument(
        "--from-supabase",
        action="store_true",
        help="Source lots from Supabase (the active `lots` table + enrichment) "
        "instead of the local parquet manifest, so comps can run without a "
        "scrape. Requires SUPABASE_URL + SUPABASE_SECRET_KEY.",
    )
    fetch_parser.add_argument(
        "--corpus-first",
        action="store_true",
        default=_cfg.corpus_first,
        help=f"Reuse the sold-listings corpus when it already covers a lot, "
        f"skipping the paid SoldComps API call. "
        f"env: GOONERS_CORPUS_FIRST, default {_cfg.corpus_first}.",
    )
    fetch_parser.add_argument("--dry-run", action="store_true")
    fetch_parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="Do not mirror snapshots to the warehouse even when a token is present",
    )
    fetch_parser.add_argument(
        "--provider-min-remaining",
        type=int,
        default=_cfg.soldcomps_min_remaining,
        help=f"Stop the run when the SoldComps provider's reported remaining "
        f"quota (its X-Usage-* response header) reaches this floor. "
        f"env: GOONERS_SOLDCOMPS_MIN_REMAINING, default {_cfg.soldcomps_min_remaining}.",
    )
    fetch_parser.add_argument("--sleep-seconds", type=float, default=1.0)

    apify_parser = subparsers.add_parser(
        "fetch-apify",
        help="Batch eBay comp fetch via Apify (automation-lab/ebay-sold-scraper).",
    )
    apify_parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    apify_parser.add_argument("--output-dir", type=Path, default=EBAY_COMPS_DIR)
    apify_parser.add_argument("--queries-per-item", type=int, default=3)
    apify_parser.add_argument("--max-matches", type=int, default=3)
    apify_parser.add_argument(
        "--max-listings-per-search",
        type=int,
        default=_cfg.apify_max_listings,
        help=f"Results to request from Apify per search query (more = higher cost). "
        f"env: GOONERS_APIFY_MAX_LISTINGS, default {_cfg.apify_max_listings}.",
    )
    apify_parser.add_argument("--stale-hours", type=int, default=DEFAULT_STALE_HOURS)
    apify_parser.add_argument(
        "--skip-attempted",
        action="store_true",
        help="Skip any item ever attempted (backfill mode, same as fetch-direct).",
    )
    apify_parser.add_argument(
        "--skip-categories",
        default=_cfg.skip_categories,
    )
    apify_parser.add_argument("--include-archived", action="store_true")
    apify_parser.add_argument("--auction-safe-id", default=None)
    apify_parser.add_argument("--dry-run", action="store_true")
    apify_parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="Do not mirror snapshots to the warehouse even when configured.",
    )
    apify_parser.add_argument(
        "--concurrency",
        type=int,
        default=_cfg.apify_concurrency,
        help=f"Max parallel Apify actor runs. "
        f"env: GOONERS_APIFY_CONCURRENCY, default {_cfg.apify_concurrency}.",
    )
    apify_parser.add_argument(
        "--api-key",
        default=secrets.apify_key(),
        help="Apify API token (defaults to APIFY_API_KEY env var).",
    )

    smoke_parser = subparsers.add_parser(
        "smoke",
        help="CI canary: fetch comps for a few items and fail if none match.",
    )
    smoke_parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    smoke_parser.add_argument("--limit", type=int, default=1)
    smoke_parser.add_argument("--queries-per-item", type=int, default=3)
    smoke_parser.add_argument("--include-archived", action="store_true")
    smoke_parser.add_argument("--sleep-seconds", type=float, default=1.0)

    return parser.parse_args(argv)


def smoke(
    data_dir: Path = DATA_DIR,
    limit: int = 1,
    queries_per_item: int = 3,
    include_archived: bool = False,
    sleep_seconds: float = 1.0,
    request_session=None,
) -> int:
    """Fetch comps for ``limit`` items into a throwaway dir; return 0 on match, 1 otherwise."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        summary = fetch_direct(
            data_dir=data_dir,
            output_dir=Path(tmp),
            limit=limit,
            queries_per_item=queries_per_item,
            stale_hours=0,
            include_archived=include_archived,
            sleep_seconds=sleep_seconds,
            mirror_to_warehouse=False,
            request_session=request_session,
        )

    matches = summary.get("matches", 0)
    print(
        f"smoke: items_attempted={summary.get('items_attempted', 0)} "
        f"matches={matches} blocked={summary.get('blocked', False)}"
    )
    if matches >= 1:
        print("SMOKE OK: found at least one eBay sold-comp match.")
        return 0
    if summary.get("blocked"):
        print("SMOKE FAIL: eBay blocked the fetch (HTTP + browser fallback).")
    else:
        print("SMOKE FAIL: no eBay sold-comp match found for any attempted item.")
    return 1


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.command == "fetch-direct":
        skip_categories = (
            frozenset(c.strip() for c in args.skip_categories.split(",") if c.strip())
            if args.skip_categories
            else None
        )
        fetch_direct(
            data_dir=args.data_dir,
            output_dir=args.output_dir,
            limit=args.limit,
            queries_per_item=args.queries_per_item,
            max_matches=args.max_matches,
            max_queries=args.max_queries,
            monthly_budget=args.monthly_budget,
            daily_pacing=not args.no_daily_pacing,
            stale_hours=args.stale_hours,
            skip_attempted=args.skip_attempted,
            skip_categories=skip_categories,
            include_archived=args.include_archived,
            auction_safe_id=args.auction_safe_id,
            dry_run=args.dry_run,
            sleep_seconds=args.sleep_seconds,
            mirror_to_warehouse=False if args.no_mirror else None,
            provider_min_remaining=args.provider_min_remaining,
            from_supabase=args.from_supabase,
            corpus_first=args.corpus_first,
        )
    elif args.command == "fetch-apify":
        skip_categories = (
            frozenset(c.strip() for c in args.skip_categories.split(",") if c.strip())
            if args.skip_categories
            else None
        )
        fetch_comps_apify(
            data_dir=args.data_dir,
            output_dir=args.output_dir,
            queries_per_item=args.queries_per_item,
            max_matches=args.max_matches,
            max_listings_per_search=args.max_listings_per_search,
            stale_hours=args.stale_hours,
            skip_attempted=args.skip_attempted,
            skip_categories=skip_categories,
            include_archived=args.include_archived,
            auction_safe_id=args.auction_safe_id,
            dry_run=args.dry_run,
            mirror_to_warehouse=False if args.no_mirror else None,
            api_key=args.api_key,
            concurrency=args.concurrency,
        )
    elif args.command == "smoke":
        return smoke(
            data_dir=args.data_dir,
            limit=args.limit,
            queries_per_item=args.queries_per_item,
            include_archived=args.include_archived,
            sleep_seconds=args.sleep_seconds,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
