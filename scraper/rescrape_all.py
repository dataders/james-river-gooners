#!/usr/bin/env python3
"""
Discover current auctions, scrape them, and keep the active manifest current.

auction_urls.txt remains a fallback/manual override list. Blank lines and
comments are skipped.
"""

import argparse
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
    for ext in (".ndjson", ".embeddings"):
        sidecar = path.with_suffix(ext)
        if sidecar.exists():
            sidecar.replace(ARCHIVE_ITEMS_DIR / sidecar.name)
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
    if path.with_suffix(".embeddings").exists():
        entry["embeddingsPath"] = f"data/{item_dir}/{path.stem}.embeddings"
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


def _discover_maxanet() -> list[str]:
    print("Discovering Maxanet (Cannon's) auctions...")
    try:
        discovered = discover_current_auction_urls()
    except Exception as exc:
        print(f"  Maxanet discovery failed: {exc}")
        discovered = []

    manual = read_manual_urls()
    if discovered:
        urls = dedupe_urls(discovered)
        print(f"  Discovered {len(urls)} Maxanet auctions")
    else:
        urls = dedupe_urls(manual)
        print(f"  Falling back to {len(urls)} configured URLs")
    return urls


def _discover_hibid() -> list[dict]:
    print("Discovering HiBid auctions...")
    try:
        specs = discover_hibid_specs()
        print(f"  Found {len(specs)} HiBid catalogs")
        return specs
    except Exception as exc:
        print(f"  HiBid discovery failed: {exc}")
        return []


def _candidate_ids_from(maxanet_urls: list[str], hibid_specs: list[dict]) -> set[str]:
    ids: set[str] = set()
    for url in maxanet_urls:
        try:
            ids.add(sanitize_auction_id(extract_auction_id(url)))
        except ValueError:
            pass
    for spec in hibid_specs:
        cid = extract_catalog_id(spec["catalog_url"])
        if cid:
            ids.add(hibid_safe_id(cid))
    return ids


def _scrape_maxanet(maxanet_urls: list[str], total: int, start_i: int) -> list[str]:
    failures: list[str] = []
    cwd = Path(__file__).resolve().parent
    for j, url in enumerate(maxanet_urls, start_i):
        print(f"\n{'='*60}")
        print(f"[{j}/{total}] Maxanet: {url[:80]}")
        print(f"{'='*60}")
        result = subprocess.run([sys.executable, "scrape.py", url], cwd=cwd)
        if result.returncode != 0:
            print(f"FAILED: {url[:80]}")
            failures.append(url)
    return failures


def _scrape_hibid(hibid_specs: list[dict], total: int, start_i: int) -> list[str]:
    failures: list[str] = []
    cwd = Path(__file__).resolve().parent
    for j, spec in enumerate(hibid_specs, start_i):
        print(f"\n{'='*60}")
        print(f"[{j}/{total}] HiBid ({spec['company_name']}): {spec['catalog_url']}")
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
    return failures


def archive_only() -> None:
    """Discover all current candidates from both sources and archive stale/closed auctions."""
    print("Archive pass: discovering current candidates from all sources...")
    maxanet_urls = _discover_maxanet()
    hibid_specs = _discover_hibid()
    candidate_ids = _candidate_ids_from(maxanet_urls, hibid_specs)
    archive_closed_and_stale(candidate_ids)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Re-scrape current auctions")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--source",
        choices=["maxanet", "hibid"],
        help="Scrape only one source (default: both). Does not archive — run --archive-only afterwards.",
    )
    group.add_argument(
        "--archive-only",
        action="store_true",
        help="Skip scraping; re-discover candidates, archive closed/stale auctions, rebuild manifests.",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    if args.archive_only:
        archive_only()
        return

    run_maxanet = args.source in (None, "maxanet")
    run_hibid = args.source in (None, "hibid")

    maxanet_urls = _discover_maxanet() if run_maxanet else []
    print()
    hibid_specs = _discover_hibid() if run_hibid else []

    total = len(maxanet_urls) + len(hibid_specs)
    if total == 0:
        print("No auction URLs found")
        sys.exit(0)

    print(f"\nRe-scraping {total} auctions ({len(maxanet_urls)} Maxanet, {len(hibid_specs)} HiBid)...")
    failures: list[str] = []
    failures += _scrape_maxanet(maxanet_urls, total, 1)
    failures += _scrape_hibid(hibid_specs, total, len(maxanet_urls) + 1)

    print(f"\n{'='*60}")
    print(f"Done: {total - len(failures)}/{total} succeeded")

    if args.source is None:
        # Full run: archive stale/closed auctions and update manifests
        candidate_ids = _candidate_ids_from(maxanet_urls, hibid_specs)
        archive_closed_and_stale(candidate_ids)
    else:
        # Partial run: just update manifests; archiving deferred to --archive-only
        update_manifests()

    if failures:
        print(f"Failed ({len(failures)}):")
        for url in failures:
            print(f"  {url[:80]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
