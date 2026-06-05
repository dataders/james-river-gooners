#!/usr/bin/env python3
"""
Backfill already-closed auctions into the archive read model.

Closed lots still serve their final sold price, so scraping them gives us a
historical sold-price corpus — the raw material for "comps" (similar past lots +
what they sold for). Three sources are supported, each closed auction scraped
into the active items dir and then moved straight into the archive
(``public/data/archive/``), with the manifests rebuilt at the end:

  * cannons — Maxanet ``GetAuctions`` ``filter=Past``. Closed cards carry no
    countdown, so ``scrape.py`` derives the end date from the title prefix.
  * rasmus  — Firestore lots whose ``time_end`` falls in the last ``--days``,
    filtered to Richmond-area (Rasmus sells nationwide).
  * hibid   — known closed catalog ids listed under ``closed_catalog_ids`` in
    ``hibid_sources.yml`` (HiBid blocks automated past-auction discovery, so the
    ids are config-driven). Closed lot pages expose "Price Realized".

Auctions already present in the active or archive read model are skipped by
default, so a backfill never clobbers data scraped while an auction was live.

Usage (from scraper/):
    uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml \
        python3 backfill_closed.py --source cannons --limit 20
    ... --source rasmus --days 90 --limit 10
    ... --source hibid --limit 10
"""

import argparse
import sys
from pathlib import Path

import yaml

from discover import discover_past_auction_urls
from rescrape_all import ARCHIVE_ITEMS_DIR, archive_file, finalize_closed_file, update_manifests
from scrape import ITEMS_DIR, extract_auction_id, sanitize_auction_id, scrape_auction
from scrape_hibid import HIBID_BASE, SOURCES_FILE as HIBID_SOURCES_FILE, hibid_safe_id, scrape_hibid_auction
from scrape_rasmus import discover_rasmus_past_specs, rasmus_safe_id, scrape_rasmus_auction

SOURCES = ("cannons", "rasmus", "hibid")


def existing_safe_ids() -> set[str]:
    """Safe IDs already present in the active or archive read model."""
    ids: set[str] = set()
    for directory in (ITEMS_DIR, ARCHIVE_ITEMS_DIR):
        if directory.exists():
            ids.update(path.stem for path in directory.glob("*.parquet"))
    return ids


def _cannons_jobs(limit: int, include_existing: bool) -> list[tuple[str, str, callable]]:
    # Over-fetch so skipped (already-scraped) auctions don't starve the limit.
    urls = discover_past_auction_urls(limit=None if include_existing else max(limit * 4, limit))
    jobs: list[tuple[str, str, callable]] = []
    for url in urls:
        try:
            safe_id = sanitize_auction_id(extract_auction_id(url))
        except ValueError:
            continue
        jobs.append((safe_id, url[:70], lambda url=url: scrape_auction(url)))
    return jobs


def _rasmus_jobs(days: int) -> list[tuple[str, str, callable]]:
    specs = discover_rasmus_past_specs(days=days)
    return [
        (
            rasmus_safe_id(spec["aid"]),
            spec["title"][:60],
            lambda spec=spec: scrape_rasmus_auction(
                spec["aid"], spec["source_slug"], spec["company_name"], spec["title"]
            ),
        )
        for spec in specs
    ]


def _hibid_jobs(sources_file: Path | None = None) -> list[tuple[str, str, callable]]:
    with open(sources_file or HIBID_SOURCES_FILE) as f:
        config = yaml.safe_load(f) or {}
    jobs: list[tuple[str, str, callable]] = []
    for company in config.get("companies", []):
        slug = company["slug"]
        name = company["name"]
        for catalog_id in company.get("closed_catalog_ids") or []:
            url = f"{HIBID_BASE}/catalog/{catalog_id}/"
            jobs.append((
                hibid_safe_id(catalog_id),
                f"{name} #{catalog_id}",
                lambda url=url, slug=slug, name=name: scrape_hibid_auction(url, slug, name),
            ))
    return jobs


def collect_jobs(source: str, limit: int, days: int, include_existing: bool):
    if source == "cannons":
        return _cannons_jobs(limit, include_existing)
    if source == "rasmus":
        return _rasmus_jobs(days)
    if source == "hibid":
        return _hibid_jobs()
    raise ValueError(f"Unknown source: {source}")


def backfill(
    source: str = "cannons",
    limit: int = 3,
    days: int = 90,
    include_existing: bool = False,
) -> int:
    """Scrape up to ``limit`` closed auctions for ``source`` into the archive.

    Returns the number of failures.
    """
    print(f"Discovering closed {source} auctions...")
    jobs = collect_jobs(source, limit, days, include_existing)
    print(f"  {len(jobs)} candidate auction(s)")

    known = set() if include_existing else existing_safe_ids()
    failures = 0
    done = 0
    for safe_id, label, run in jobs:
        if done >= limit:
            break
        if safe_id in known:
            print(f"  Skipping {safe_id} (already in read model)")
            continue

        print(f"\n{'=' * 60}")
        print(f"[{done + 1}/{limit}] Backfilling {source}: {label}")
        print(f"{'=' * 60}")
        try:
            run()
        except Exception as exc:  # one bad auction shouldn't abort the batch
            print(f"FAILED: {label} :: {exc}")
            failures += 1
            done += 1
            continue

        parquet = ITEMS_DIR / f"{safe_id}.parquet"
        if parquet.exists():
            # Backfilled auctions are closed by definition — stamp the final sold
            # price (#94) before moving the files into the archive.
            finalize_closed_file(parquet)
            archive_file(parquet)
        else:
            print(f"  Nothing written for {safe_id} (skipped/empty); not archived")
        known.add(safe_id)
        done += 1

    update_manifests()
    print(f"\nBackfill complete: {done - failures}/{done} {source} auctions archived")
    return failures


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill closed auctions into the archive"
    )
    parser.add_argument("--source", choices=SOURCES, default="cannons")
    parser.add_argument(
        "--limit",
        type=int,
        default=3,
        help="Number of new closed auctions to backfill (default: 3).",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=90,
        help="Rasmus only: how many days back to scan for closed auctions.",
    )
    parser.add_argument(
        "--include-existing",
        action="store_true",
        help="Re-scrape auctions already in the read model (clobbers data "
        "captured while the auction was live). Off by default.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    failures = backfill(
        source=args.source,
        limit=args.limit,
        days=args.days,
        include_existing=args.include_existing,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
