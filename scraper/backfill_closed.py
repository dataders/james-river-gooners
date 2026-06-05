#!/usr/bin/env python3
"""
Backfill already-closed Cannon's auctions into the archive read model.

Cannon's exposes past (closed) auctions via the same GetAuctions endpoint with
``filter=Past``. Each closed lot still serves its final hammer price in
``currentBid``, so scraping them gives us a historical sold-price corpus — the
raw material for "Cannon's comps" (similar past lots + what they sold for).

Closed auction cards carry no live countdown, so ``scrape.py`` derives the
auction end date from the title prefix (e.g. ``"06/04/26: ..."``). Each scraped
auction is then moved straight into the archive (``public/data/archive/``) and
the manifests are rebuilt.

By default auctions already present in the active or archive read model are
skipped, so a backfill never clobbers data scraped while the auction was still
live (which carries precise per-lot end times).

Usage (from scraper/):
    uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml \
        python3 backfill_closed.py --limit 3
"""

import argparse
import sys
from pathlib import Path

from discover import discover_past_auction_urls
from rescrape_all import ARCHIVE_ITEMS_DIR, archive_file, update_manifests
from scrape import ITEMS_DIR, extract_auction_id, sanitize_auction_id, scrape_auction


def existing_safe_ids() -> set[str]:
    """Safe IDs already present in the active or archive read model."""
    ids: set[str] = set()
    for directory in (ITEMS_DIR, ARCHIVE_ITEMS_DIR):
        if directory.exists():
            ids.update(path.stem for path in directory.glob("*.parquet"))
    return ids


def backfill(limit: int, include_existing: bool = False) -> int:
    """Scrape up to ``limit`` closed auctions into the archive. Returns failures."""
    print(f"Discovering up to {limit} past Cannon's auctions...")
    urls = discover_past_auction_urls(limit=None if include_existing else limit * 4)
    print(f"  Found {len(urls)} closed auctions")

    known = set() if include_existing else existing_safe_ids()
    failures = 0
    done = 0
    for url in urls:
        if done >= limit:
            break
        try:
            safe_id = sanitize_auction_id(extract_auction_id(url))
        except ValueError:
            continue
        if safe_id in known:
            print(f"  Skipping {safe_id} (already in read model)")
            continue

        print(f"\n{'=' * 60}")
        print(f"[{done + 1}/{limit}] Backfilling: {url[:80]}")
        print(f"{'=' * 60}")
        try:
            scrape_auction(url)
        except Exception as exc:  # keep going; one bad auction shouldn't abort the batch
            print(f"FAILED: {url[:80]} :: {exc}")
            failures += 1
            done += 1
            continue

        parquet = ITEMS_DIR / f"{safe_id}.parquet"
        if parquet.exists():
            archive_file(parquet)
        known.add(safe_id)
        done += 1

    update_manifests()
    print(f"\nBackfill complete: {done - failures}/{done} auctions archived")
    return failures


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill closed Cannon's auctions into the archive"
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=3,
        help="Number of new closed auctions to backfill (default: 3).",
    )
    parser.add_argument(
        "--include-existing",
        action="store_true",
        help="Re-scrape auctions already in the read model (clobbers precise "
        "end times captured while the auction was live). Off by default.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    failures = backfill(limit=args.limit, include_existing=args.include_existing)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
