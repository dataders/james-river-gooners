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

from dates import parse_auction_datetime_utc
from discover import discover_current_auction_urls
from scrape import DATA_DIR, ITEMS_DIR, extract_auction_id, sanitize_auction_id
from scrape_hibid import discover_hibid_specs, hibid_safe_id, extract_catalog_id


URLS_FILE = Path(__file__).resolve().parent / "auction_urls.txt"
ARCHIVE_ITEMS_DIR = DATA_DIR / "archive" / "items"
MANIFEST_PATH = DATA_DIR / "manifest.json"
ARCHIVE_MANIFEST_PATH = DATA_DIR / "archive-manifest.json"


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
    return parse_auction_datetime_utc(value)


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
    return end_date <= datetime.now(timezone.utc)


def archive_file(path: Path) -> None:
    ARCHIVE_ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    target = ARCHIVE_ITEMS_DIR / path.name
    path.replace(target)
    ndjson = path.with_suffix(".ndjson")
    if ndjson.exists():
        ndjson.replace(ARCHIVE_ITEMS_DIR / ndjson.name)
    print(f"Archived closed auction data: {path.name}")


def parquet_first_value(path: Path, column: str) -> str:
    try:
        table = pq.read_table(path, columns=[column])
    except Exception:
        return ""

    values = table.column(column).to_pylist()
    for value in values:
        if value is not None:
            return str(value)
    return ""


def manifest_entry_for_file(path: Path, archived: bool) -> dict:
    item_count = 0
    try:
        item_count = pq.ParquetFile(path).metadata.num_rows
    except Exception:
        pass

    item_dir = "archive/items" if archived else "items"
    entry = {
        "safeId": path.stem,
        "title": parquet_first_value(path, "auctionTitle"),
        "endDate": parquet_first_value(path, "auctionEndDate"),
        "scrapedAt": parquet_first_value(path, "scrapedAt"),
        "itemCount": item_count,
        "itemsPath": f"data/{item_dir}/{path.name}",
        "source": parquet_first_value(path, "source"),
    }
    if path.with_suffix(".ndjson").exists():
        entry["ndjsonPath"] = f"data/{item_dir}/{path.stem}.ndjson"
    return entry


def manifest_sort_key(entry: dict) -> tuple[datetime, str]:
    parsed = parse_end_date(str(entry.get("endDate", "")))
    return parsed or datetime.max.replace(tzinfo=timezone.utc), entry.get("title") or entry.get("safeId", "")


def build_manifest(paths: list[Path], archived: bool) -> dict:
    entries = [manifest_entry_for_file(path, archived) for path in paths]
    entries.sort(key=manifest_sort_key)
    return {"auctions": entries}


def update_manifests() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    active_paths = sorted(ITEMS_DIR.glob("*.parquet")) if ITEMS_DIR.exists() else []
    archive_paths = sorted(ARCHIVE_ITEMS_DIR.glob("*.parquet")) if ARCHIVE_ITEMS_DIR.exists() else []
    active_manifest = build_manifest(active_paths, archived=False)
    archive_manifest = build_manifest(archive_paths, archived=True)
    MANIFEST_PATH.write_text(json.dumps(active_manifest, indent=2) + "\n")
    ARCHIVE_MANIFEST_PATH.write_text(json.dumps(archive_manifest, indent=2) + "\n")
    print(f"Active manifest: {len(active_manifest['auctions'])} auctions")
    print(f"Archive manifest: {len(archive_manifest['auctions'])} auctions")


def archive_closed_and_stale(current_candidate_ids: set[str]) -> None:
    if not ITEMS_DIR.exists():
        update_manifests()
        return

    for path in sorted(ITEMS_DIR.glob("*.parquet")):
        if path.stem not in current_candidate_ids or is_closed(path):
            archive_file(path)

    update_manifests()


def main():
    # --- Maxanet discovery ---
    print("Discovering Maxanet (Cannon's) auctions...")
    try:
        discovered_urls = discover_current_auction_urls()
    except Exception as exc:
        print(f"  Maxanet discovery failed: {exc}")
        discovered_urls = []

    manual_urls = read_manual_urls()
    if discovered_urls:
        maxanet_urls = discovered_urls
        print(f"  Discovered {len(discovered_urls)} Maxanet auctions")
    else:
        maxanet_urls = manual_urls
        print(f"  Falling back to {len(manual_urls)} configured URLs")

    maxanet_urls = dedupe_urls(maxanet_urls)

    # --- HiBid discovery ---
    print("\nDiscovering HiBid auctions...")
    try:
        hibid_specs = discover_hibid_specs()
        print(f"  Found {len(hibid_specs)} HiBid catalogs")
    except Exception as exc:
        print(f"  HiBid discovery failed: {exc}")
        hibid_specs = []

    total = len(maxanet_urls) + len(hibid_specs)
    if total == 0:
        print("No auction URLs found")
        sys.exit(0)

    # Build set of current safe IDs for archiving stale files
    current_candidate_ids: set[str] = set()
    for url in maxanet_urls:
        try:
            current_candidate_ids.add(sanitize_auction_id(extract_auction_id(url)))
        except ValueError:
            pass
    for spec in hibid_specs:
        cid = extract_catalog_id(spec["catalog_url"])
        if cid:
            current_candidate_ids.add(hibid_safe_id(cid))

    print(f"\nRe-scraping {total} auctions ({len(maxanet_urls)} Maxanet, {len(hibid_specs)} HiBid)...")
    failures: list[str] = []
    i = 0
    cwd = Path(__file__).resolve().parent

    # Maxanet auctions
    for url in maxanet_urls:
        i += 1
        print(f"\n{'='*60}")
        print(f"[{i}/{total}] Maxanet: {url[:80]}")
        print(f"{'='*60}")
        result = subprocess.run([sys.executable, "scrape.py", url], cwd=cwd)
        if result.returncode != 0:
            print(f"FAILED: {url[:80]}")
            failures.append(url)

    # HiBid auctions
    for spec in hibid_specs:
        i += 1
        print(f"\n{'='*60}")
        print(f"[{i}/{total}] HiBid ({spec['company_name']}): {spec['catalog_url']}")
        print(f"{'='*60}")
        result = subprocess.run(
            [
                sys.executable, "scrape_hibid.py",
                spec["catalog_url"],
                "--source", spec["source_slug"],
                "--company", spec["company_name"],
            ],
            cwd=cwd,
        )
        if result.returncode != 0:
            print(f"FAILED: {spec['catalog_url']}")
            failures.append(spec["catalog_url"])

    print(f"\n{'='*60}")
    print(f"Done: {total - len(failures)}/{total} succeeded")
    archive_closed_and_stale(current_candidate_ids)
    if failures:
        print(f"Failed ({len(failures)}):")
        for url in failures:
            print(f"  {url[:80]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
