#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "beautifulsoup4",
#     "pyarrow",
#     "pyyaml",
# ]
# ///
"""
Discover current auctions, scrape them, and keep the active manifest current.

auction_urls.txt remains a fallback/manual override list. Blank lines and
comments are skipped.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import env_secrets as secrets
import pyarrow.parquet as pq
from dates import parse_auction_datetime_utc
from discover import discover_current_auction_urls
from scrape import DATA_DIR, ITEMS_DIR, extract_auction_id, sanitize_auction_id
from scrape_facebook import discover_facebook_specs
from scrape_hibid import discover_hibid_specs, extract_catalog_id, hibid_safe_id
from scrape_rasmus import discover_rasmus_specs, rasmus_safe_id

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
    return end_date <= datetime.now(UTC)


def finalize_closed_file(path: Path) -> None:
    """Stamp a closing auction's lots with their final sold price (#94).

    When an auction actually closes there's no truer record of the hammer price
    than the last-seen ``currentBid``, so we promote it to ``finalBid`` and mark
    ``closed=True`` the moment we archive the auction. Rewrites both the NDJSON
    (images stay arrays) and the Parquet (images stringified, mirroring
    scrape.py) in place; the caller then moves them into the archive. Idempotent
    and source-agnostic — it operates on whatever rows the file holds, and never
    clobbers a finalBid that was already captured (e.g. by backfill_closed)."""
    import pyarrow as pa

    ndjson_path = path.with_suffix(".ndjson")
    if not ndjson_path.exists():
        return

    rows = [
        json.loads(line)
        for line in ndjson_path.read_text().splitlines()
        if line.strip()
    ]
    if not rows:
        return

    for row in rows:
        row["closed"] = True
        if row.get("finalBid") is None:
            try:
                bid = float(row.get("currentBid") or 0)
            except (TypeError, ValueError):
                bid = 0.0
            # A lot that closed at $0 drew no bids — it didn't sell, so it has no
            # final price (None), not a $0 sale.
            row["finalBid"] = bid if bid > 0 else None

    ndjson_path.write_text(
        "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n",
        encoding="utf-8",
    )

    # Parquet stores images as a JSON string (Arrow can't infer list-of-strings
    # here), matching how scrape.py writes the active file.
    for row in rows:
        if isinstance(row.get("images"), list):
            row["images"] = json.dumps(row["images"])
    pq.write_table(pa.Table.from_pylist(rows), path, compression="snappy")
    print(f"Finalized {len(rows)} closed lots with final sold price: {path.name}")


def backfill_archive_final_prices() -> int:
    """One-time backfill: stamp closed/finalBid onto already-archived lots (#94).

    Auctions archived before #94 carry no final-price marker. Re-running the same
    idempotent finalize over every file in the archive promotes each lot's
    last-seen currentBid to finalBid and marks it closed, without clobbering any
    finalBid already present. Returns the number of archived files visited."""
    if not ARCHIVE_ITEMS_DIR.exists():
        print("No archive directory to backfill.")
        return 0
    count = 0
    for path in sorted(ARCHIVE_ITEMS_DIR.glob("*.parquet")):
        finalize_closed_file(path)
        count += 1
    print(f"Backfilled final prices across {count} archived auction file(s).")
    return count


def archive_file(path: Path) -> None:
    ARCHIVE_ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    target = ARCHIVE_ITEMS_DIR / path.name
    path.replace(target)
    sidecar = path.with_suffix(".ndjson")
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
    return entry


def manifest_sort_key(entry: dict) -> tuple[datetime, str]:
    parsed = parse_end_date(str(entry.get("endDate", "")))
    return parsed or datetime.max.replace(tzinfo=UTC), entry.get("title") or entry.get(
        "safeId", ""
    )


def build_manifest(paths: list[Path], archived: bool) -> dict:
    entries = [manifest_entry_for_file(path, archived) for path in paths]
    entries.sort(key=manifest_sort_key)
    return {"auctions": entries}


def update_manifests() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    active_paths = sorted(ITEMS_DIR.glob("*.parquet")) if ITEMS_DIR.exists() else []
    archive_paths = (
        sorted(ARCHIVE_ITEMS_DIR.glob("*.parquet"))
        if ARCHIVE_ITEMS_DIR.exists()
        else []
    )
    active_manifest = build_manifest(active_paths, archived=False)
    archive_manifest = build_manifest(archive_paths, archived=True)
    MANIFEST_PATH.write_text(json.dumps(active_manifest, indent=2) + "\n")
    ARCHIVE_MANIFEST_PATH.write_text(json.dumps(archive_manifest, indent=2) + "\n")
    print(f"Active manifest: {len(active_manifest['auctions'])} auctions")
    print(f"Archive manifest: {len(archive_manifest['auctions'])} auctions")


def _supabase_archive_file(path: Path) -> None:
    """Sync finalized lots to Supabase as archived before the files are moved."""
    if not secrets.supabase_secret_key():
        return
    ndjson = path.with_suffix(".ndjson")
    if not ndjson.exists():
        return
    items = [
        json.loads(line) for line in ndjson.read_text().splitlines() if line.strip()
    ]
    if items:
        from supabase_lots import archive_lots

        archive_lots(path.stem, items)


def archive_closed_and_stale(current_candidate_ids: set[str]) -> None:
    if not ITEMS_DIR.exists():
        update_manifests()
        return

    for path in sorted(ITEMS_DIR.glob("*.parquet")):
        closed = is_closed(path)
        if path.stem not in current_candidate_ids or closed:
            # Only stamp finalBid/closed when the auction has truly ended — a
            # stale auction merely dropped from discovery may still be live.
            if closed:
                finalize_closed_file(path)
            _supabase_archive_file(path)
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


def _discover_rasmus() -> list[dict]:
    print("Discovering Rasmus auctions...")
    try:
        specs = discover_rasmus_specs()
        print(f"  Found {len(specs)} Richmond-area Rasmus auctions")
        return specs
    except Exception as exc:
        print(f"  Rasmus discovery failed: {exc}")
        return []


def _discover_facebook() -> list[dict]:
    print("Discovering Facebook Marketplace searches...")
    try:
        specs = discover_facebook_specs()
        print(f"  Found {len(specs)} Facebook Marketplace searches")
        return specs
    except Exception as exc:
        print(f"  Facebook Marketplace discovery failed: {exc}")
        return []


def _candidate_ids_from(
    maxanet_urls: list[str],
    hibid_specs: list[dict],
    rasmus_specs: list[dict] | None = None,
    facebook_specs: list[dict] | None = None,
) -> set[str]:
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
    for spec in rasmus_specs or []:
        ids.add(rasmus_safe_id(spec["aid"]))
    for spec in facebook_specs or []:
        ids.add(spec["safe_id"])
    return ids


def _run_with_retry(cmd: list[str], cwd: Path, label: str) -> int:
    """Run cmd, retrying once on non-zero exit. Returns final returncode."""
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    for attempt in range(2):
        result = subprocess.run(cmd, cwd=cwd, env=env)
        if result.returncode == 0:
            return 0
        if attempt == 0:
            print(f"  attempt 1 failed (exit {result.returncode}); retrying {label}...")
            time.sleep(2)
    return result.returncode


# --- Generic per-source scrape driver -------------------------------------
#
# All three sources run the identical loop: print a banner, shell out to the
# source's scrape script as an isolated subprocess (retried once), and collect
# failures. Only the banner text and the command differ per source, so each
# source supplies a *job builder* that turns one spec into a SourceJob; the
# driver below runs them. (Subprocesses, not in-process calls, are deliberate:
# they contain a crashing auction and keep the ~550 MB embedding models from
# accumulating across auctions in one process.)


@dataclass
class SourceJob:
    """A single auction's subprocess invocation, plus how to label it in logs."""

    header: str  # banner line after "[i/total] <SourceName>: "
    cmd: list[str]  # argv for the subprocess
    retry_label: str  # short label for the retry message
    fail_id: str  # what to record/print when the job fails


@dataclass
class SourceRunner:
    """Binds a source's display name to its spec→SourceJob builder."""

    name: str
    build: Callable[..., SourceJob]


def _maxanet_job(url: str) -> SourceJob:
    return SourceJob(
        header=url[:80],
        cmd=[sys.executable, "scrape.py", url],
        retry_label=url[:60],
        fail_id=url,
    )


def _hibid_job(spec: dict) -> SourceJob:
    return SourceJob(
        header=f"({spec['company_name']}): {spec['catalog_url']}",
        cmd=[
            sys.executable,
            "scrape_hibid.py",
            spec["catalog_url"],
            "--source",
            spec["source_slug"],
            "--company",
            spec["company_name"],
        ],
        retry_label=spec["catalog_url"],
        fail_id=spec["catalog_url"],
    )


def _rasmus_job(spec: dict) -> SourceJob:
    return SourceJob(
        header=f"({spec['company_name']}): {spec['title'][:60]}",
        cmd=[
            sys.executable,
            "scrape_rasmus.py",
            spec["aid"],
            "--source",
            spec["source_slug"],
            "--company",
            spec["company_name"],
            "--title",
            spec["title"],
        ],
        retry_label=spec["aid"],
        fail_id=spec["aid"],
    )


def _facebook_job(spec: dict) -> SourceJob:
    return SourceJob(
        header=spec["keyword"],
        cmd=[sys.executable, "scrape_facebook.py", "--keyword", spec["keyword"]],
        retry_label=spec["keyword"],
        fail_id=spec["safe_id"],
    )


MAXANET = SourceRunner("Maxanet", _maxanet_job)
HIBID = SourceRunner("HiBid", _hibid_job)
RASMUS = SourceRunner("Rasmus", _rasmus_job)
FACEBOOK = SourceRunner("Facebook", _facebook_job)


def _scrape_source(
    runner: SourceRunner, specs: list, total: int, start_i: int
) -> list[str]:
    """Run every spec for one source as an isolated subprocess; return failures."""
    failures: list[str] = []
    cwd = Path(__file__).resolve().parent
    for j, spec in enumerate(specs, start_i):
        job = runner.build(spec)
        print(f"\n{'=' * 60}")
        print(f"[{j}/{total}] {runner.name}: {job.header}")
        print(f"{'=' * 60}")
        rc = _run_with_retry(job.cmd, cwd, job.retry_label)
        if rc != 0:
            print(f"FAILED: {job.header}")
            failures.append(job.fail_id)
    return failures


def archive_only() -> None:
    """Discover all current candidates from every source and archive stale/closed auctions."""
    print("Archive pass: discovering current candidates from all sources...")
    maxanet_urls = _discover_maxanet()
    hibid_specs = _discover_hibid()
    rasmus_specs = _discover_rasmus()
    facebook_specs = _discover_facebook()
    candidate_ids = _candidate_ids_from(
        maxanet_urls, hibid_specs, rasmus_specs, facebook_specs
    )
    archive_closed_and_stale(candidate_ids)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Re-scrape current auctions")
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--source",
        choices=["maxanet", "hibid", "rasmus", "facebook"],
        help="Scrape only one source (default: all). Does not archive — run --archive-only afterwards.",
    )
    group.add_argument(
        "--archive-only",
        action="store_true",
        help="Skip scraping; re-discover candidates, archive closed/stale auctions, rebuild manifests.",
    )
    group.add_argument(
        "--backfill-final-prices",
        action="store_true",
        help="One-time: stamp closed/finalBid onto already-archived lots (#94), then exit.",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    if args.backfill_final_prices:
        backfill_archive_final_prices()
        return

    if args.archive_only:
        archive_only()
        return

    run_maxanet = args.source in (None, "maxanet")
    run_hibid = args.source in (None, "hibid")
    run_rasmus = args.source in (None, "rasmus")
    run_facebook = args.source in (None, "facebook")

    maxanet_urls = _discover_maxanet() if run_maxanet else []
    print()
    hibid_specs = _discover_hibid() if run_hibid else []
    print()
    rasmus_specs = _discover_rasmus() if run_rasmus else []
    print()
    facebook_specs = _discover_facebook() if run_facebook else []

    total = (
        len(maxanet_urls) + len(hibid_specs) + len(rasmus_specs) + len(facebook_specs)
    )
    if total == 0:
        print("No auction URLs found")
        sys.exit(0)

    print(
        f"\nRe-scraping {total} auctions "
        f"({len(maxanet_urls)} Maxanet, {len(hibid_specs)} HiBid, "
        f"{len(rasmus_specs)} Rasmus, {len(facebook_specs)} Facebook)..."
    )
    failures: list[str] = []
    failures += _scrape_source(MAXANET, maxanet_urls, total, 1)
    failures += _scrape_source(HIBID, hibid_specs, total, len(maxanet_urls) + 1)
    failures += _scrape_source(
        RASMUS, rasmus_specs, total, len(maxanet_urls) + len(hibid_specs) + 1
    )
    failures += _scrape_source(
        FACEBOOK,
        facebook_specs,
        total,
        len(maxanet_urls) + len(hibid_specs) + len(rasmus_specs) + 1,
    )

    print(f"\n{'=' * 60}")
    print(f"Done: {total - len(failures)}/{total} succeeded")

    if args.source is None:
        # Full run: archive stale/closed auctions and update manifests
        candidate_ids = _candidate_ids_from(
            maxanet_urls, hibid_specs, rasmus_specs, facebook_specs
        )
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
