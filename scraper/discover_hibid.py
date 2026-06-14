#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "beautifulsoup4",
#     "pyarrow",
#     "pyyaml",
#     "ruamel.yaml",
# ]
# ///
"""
Discover new HiBid catalog IDs and update hibid_sources.yml.

Uses Playwright to fetch company pages so HiBid's bot protection is bypassed
regardless of which infrastructure this runs on. Adds new catalog IDs;
existing ones are preserved so the scraper's hourly rescrape_all.py can pick
them up automatically.

Usage:
    uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml --with ruamel.yaml --with playwright \\
        python discover_hibid.py
"""

import sys
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedSeq
from scrape_hibid import (
    HIBID_BASE,
    create_session,
    discover_company_catalogs,
    is_real_estate_auction,
)

SOURCES_FILE = Path(__file__).resolve().parent / "hibid_sources.yml"


def fetch_page_playwright(url: str) -> str | None:
    """Fetch a page with a real Chromium browser to bypass bot protection."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(url, wait_until="load", timeout=30000)
            return page.content()
        except Exception as exc:
            print(f"  Warning: Playwright fetch failed for {url}: {exc}")
            return None
        finally:
            browser.close()


def main() -> int:
    ryaml = YAML()
    ryaml.preserve_quotes = True
    ryaml.width = 4096  # prevent ruamel from wrapping long comment lines
    ryaml.indent(mapping=2, sequence=4, offset=2)  # match original file's indent style

    with open(SOURCES_FILE) as f:
        config = ryaml.load(f)

    session = create_session()
    total_added = 0

    for company in config.get("companies", []):
        company_id = company["id"]
        name = company["name"]

        existing_ids = {str(cid) for cid in (company.get("catalog_ids") or [])}
        closed_ids = {str(cid) for cid in (company.get("closed_catalog_ids") or [])}
        known_ids = existing_ids | closed_ids

        print(f"Checking {name} (HiBid #{company_id})...")
        url = f"{HIBID_BASE}/company/{company_id}/"
        html = fetch_page_playwright(url)
        catalogs = discover_company_catalogs(session, company_id, html=html)

        if not catalogs:
            print("  No catalogs found (company page unavailable or blocked)")
            continue

        added = 0
        for cat in catalogs:
            cid = str(cat["catalog_id"])
            title = cat.get("title", "")
            if is_real_estate_auction(title):
                continue
            if cid in known_ids:
                continue

            label = title[:50] if title else f"catalog {cid}"
            print(f"  + {cid}: {label}")

            if not company.get("catalog_ids"):
                company["catalog_ids"] = CommentedSeq()

            company["catalog_ids"].append(int(cid))
            idx = len(company["catalog_ids"]) - 1
            company["catalog_ids"].yaml_add_eol_comment(label, idx)

            added += 1
            total_added += 1

        if not added:
            found_ids = {str(c["catalog_id"]) for c in catalogs}
            print(f"  No new catalogs (found {len(found_ids)}, all already known)")

    if total_added > 0:
        with open(SOURCES_FILE, "w") as f:
            ryaml.dump(config, f)
        print(f"\nUpdated hibid_sources.yml — added {total_added} new catalog(s)")
    else:
        print("\nNo changes — hibid_sources.yml is up to date")

    return 0


if __name__ == "__main__":
    sys.exit(main())
