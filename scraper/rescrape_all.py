#!/usr/bin/env python3
"""
Re-scrape all auctions listed in auction_urls.txt.

Each line in the file is a full Cannon's auction URL.
Blank lines and lines starting with # are skipped.
"""

import subprocess
import sys
from pathlib import Path

URLS_FILE = Path(__file__).resolve().parent / "auction_urls.txt"


def main():
    if not URLS_FILE.exists():
        print(f"No {URLS_FILE} found — nothing to re-scrape.")
        print("Add auction URLs (one per line) to this file.")
        sys.exit(0)

    urls = []
    for line in URLS_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line)

    if not urls:
        print("No URLs found in auction_urls.txt")
        sys.exit(0)

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
    if failures:
        print(f"Failed ({len(failures)}):")
        for url in failures:
            print(f"  {url[:80]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
