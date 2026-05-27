#!/usr/bin/env python3
"""
Discover current auctions, scrape them, and keep the active manifest current.

auction_urls.txt remains a fallback/manual override list. Blank lines and
comments are skipped.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as pq

from discover import discover_current_auction_urls
from scrape import DATA_DIR, ITEMS_DIR, extract_auction_id, sanitize_auction_id


URLS_FILE = Path(__file__).resolve().parent / "auction_urls.txt"
ARCHIVE_ITEMS_DIR = DATA_DIR / "archive" / "items"
MANIFEST_PATH = DATA_DIR / "manifest.json"
ARCHIVE_MANIFEST_PATH = DATA_DIR / "archive-manifest.json"

DATE_PATTERNS = (
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %I:%M:%S %p",
    "%Y-%m-%d %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
)


def read_manual_urls() -> list[str]:
    if not URLS_FILE.exists():
        return []

    urls = []
    for line in URLS_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)
    return urls


def dedupe_urls(urls: list[str]) -> list[str]:
    deduped = []
    seen = set()
    for url in urls:
        try:
            key = extract_auction_id(url)
        except ValueError:
            key = url
        if key in seen:
            continue
        seen.add(key)
        deduped.append(url)
    return deduped


def parse_end_date(value: str) -> datetime | None:
    if not value:
        return None
    cleaned = value.strip()
    if cleaned.endswith("Z"):
        cleaned = f"{cleaned[:-1]}+0000"
    for pattern in DATE_PATTERNS:
        try:
            parsed = datetime.strptime(cleaned, pattern)
            if parsed.tzinfo is not None:
                return parsed.astimezone(timezone.utc).replace(tzinfo=None)
            return parsed
        except ValueError:
            continue
    return None


def parquet_end_date(path: Path) -> datetime | None:
    try:
        table = pq.read_table(path, columns=["auctionEndDate"])
    except Exception:
        return None
    values = table.column("auctionEndDate").to_pylist()
    for value in values:
        parsed = parse_end_date(str(value))
        if parsed is not None:
            return parsed
    return None


def is_closed(path: Path) -> bool:
    end_date = parquet_end_date(path)
    if end_date is None:
        return False
    return end_date <= datetime.now()


def archive_file(path: Path) -> None:
    ARCHIVE_ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    target = ARCHIVE_ITEMS_DIR / path.name
    path.replace(target)
    print(f"Archived closed auction data: {path.name}")


def update_manifests() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    active_ids = sorted(p.stem for p in ITEMS_DIR.glob("*.parquet"))
    archive_ids = sorted(p.stem for p in ARCHIVE_ITEMS_DIR.glob("*.parquet"))
    MANIFEST_PATH.write_text(json.dumps(active_ids, indent=2) + "\n")
    ARCHIVE_MANIFEST_PATH.write_text(json.dumps(archive_ids, indent=2) + "\n")
    print(f"Active manifest: {len(active_ids)} auctions")
    print(f"Archive manifest: {len(archive_ids)} auctions")


def archive_closed_and_stale(current_candidate_ids: set[str]) -> None:
    if not ITEMS_DIR.exists():
        update_manifests()
        return

    for path in sorted(ITEMS_DIR.glob("*.parquet")):
        if path.stem not in current_candidate_ids or is_closed(path):
            archive_file(path)

    update_manifests()


def main():
    print("Discovering current auctions...")
    try:
        discovered_urls = discover_current_auction_urls()
    except Exception as exc:
        print(f"Discovery failed: {exc}")
        discovered_urls = []

    manual_urls = read_manual_urls()
    if discovered_urls:
        urls = discovered_urls
        print(f"Discovered {len(discovered_urls)} current auctions")
    else:
        urls = manual_urls
        print(f"Falling back to {len(manual_urls)} configured auction URLs")

    urls = dedupe_urls(urls)
    if not urls:
        print("No auction URLs found")
        sys.exit(0)

    current_candidate_ids = {
        sanitize_auction_id(extract_auction_id(url))
        for url in urls
    }

    print(f"Re-scraping {len(urls)} auctions...")
    failures = []

    for i, url in enumerate(urls, 1):
        print(f"\n{'='*60}")
        print(f"[{i}/{len(urls)}] {url[:80]}...")
        print(f"{'='*60}")
        result = subprocess.run(
            [sys.executable, "scrape.py", url],
            cwd=Path(__file__).resolve().parent,
        )
        if result.returncode != 0:
            print(f"FAILED: {url[:80]}")
            failures.append(url)

    print(f"\n{'='*60}")
    print(f"Done: {len(urls) - len(failures)}/{len(urls)} succeeded")
    archive_closed_and_stale(current_candidate_ids)
    if failures:
        print(f"Failed ({len(failures)}):")
        for url in failures:
            print(f"  {url[:80]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
