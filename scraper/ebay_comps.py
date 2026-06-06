#!/usr/bin/env python
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

See docs/data-architecture.md.
"""

import argparse
import os
import random
import sys
from pathlib import Path

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
    fetch_sold_matches,
    html_from_browser_output,
    is_ebay_item_url,
    parse_sold_search_html,
    run_agent_browser,
    soldcomps_sold_matches,
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
from ebay_snapshot import (
    EXPORT_COLUMNS,
    PUBLIC_VIEW,
    SNAPSHOT_TABLE,
    append_ebay_comp_snapshots,
    comp_rows_for_item,
    comp_row_values,
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

# Keep these available for the rare callers that import the SQL templates.
from ebay_snapshot import CREATE_COMP_TABLE_SQL, INSERT_COMP_SQL, PUBLIC_VIEW_SQL

DEFAULT_LIMIT = 50
DEFAULT_STALE_HOURS = 7 * 24
DEFAULT_MONTHLY_BUDGET = 5000


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
    }
    if limit <= 0:
        return summary

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

    cap_active, query_limit = resolve_query_budget(
        ledger, monthly_budget, max_queries, daily_pacing
    )
    if cap_active and query_limit <= 0:
        print("eBay comp fetch: request budget exhausted for now; nothing to do.")
        return summary

    session = request_session or requests.Session()
    generated_at = utc_now_text()
    all_rows: list[dict] = []
    attempts: dict[str, dict[str, dict]] = {}

    candidates = sorted(
        load_manifest_items(
            data_dir=data_dir,
            include_archived=include_archived,
            auction_safe_id=auction_safe_id,
        ),
        key=auction_end_sort_key,
    )

    for item in candidates:
        safe_id = text_value(item.get("auctionSafeId"))
        item_id = text_value(item.get("id"))
        if f"{safe_id}:{item_id}" in known_fresh:
            continue
        if skip_categories and item.get("category") in skip_categories:
            continue

        searches = build_ebay_sold_searches(item)[:queries_per_item]
        if not searches:
            continue

        if summary["items_attempted"] >= limit:
            break
        if cap_active and summary["queries_attempted"] >= query_limit:
            break
        summary["items_attempted"] += 1

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

        if summary["blocked"]:
            break

    if dry_run:
        print(
            f"eBay comp fetch (dry run): {summary['items_attempted']} items, "
            f"{summary['queries_attempted']} queries planned"
        )
        return summary

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
    print(
        f"eBay comp fetch: {summary['items_attempted']} items, "
        f"{summary['queries_attempted']} queries, {summary['matches']} matches, "
        f"{written_msg}"
    )
    if monthly_budget > 0:
        used = ledger.requests_used_in_month()
        print(
            f"Monthly request budget: {used}/{monthly_budget} used "
            f"({max(0, monthly_budget - used)} remaining)"
        )
    return summary


# ── CLI ────────────────────────────────────────────────────────────────────────

def parse_args(argv: list[str]) -> argparse.Namespace:
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
        "--limit", type=int, default=int(os.environ.get("GOONERS_EBAY_COMPS_LIMIT", DEFAULT_LIMIT))
    )
    fetch_parser.add_argument("--queries-per-item", type=int, default=3)
    fetch_parser.add_argument("--max-matches", type=int, default=3)
    fetch_parser.add_argument(
        "--max-queries",
        type=int,
        default=int(os.environ.get("GOONERS_EBAY_COMPS_MAX_QUERIES", "0")),
        help="Hard cap on SoldComps requests this run (1 query = 1 request). "
        "0 disables this per-run cap; the monthly budget still applies.",
    )
    fetch_parser.add_argument(
        "--monthly-budget",
        type=int,
        default=int(
            os.environ.get("GOONERS_EBAY_COMPS_MONTHLY_BUDGET", str(DEFAULT_MONTHLY_BUDGET))
        ),
        help="Shared monthly request ceiling across all runs (derived from the "
        "read model). 0 disables it.",
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
        default=os.environ.get("GOONERS_EBAY_COMPS_SKIP_CATEGORIES", ""),
        help="Comma-separated broad category groups to skip entirely "
        "(e.g. 'Collectibles,Jewelry & Watches,Coins & Currency,China & Glass'). "
        "Also reads GOONERS_EBAY_COMPS_SKIP_CATEGORIES env var.",
    )
    fetch_parser.add_argument("--include-archived", action="store_true")
    fetch_parser.add_argument("--dry-run", action="store_true")
    fetch_parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="Do not mirror snapshots to the warehouse even when a token is present",
    )
    fetch_parser.add_argument("--sleep-seconds", type=float, default=1.0)

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
