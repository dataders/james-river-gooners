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
HiBid auction scraper for Richmond-area auction houses.

Discovers active catalogs for each company in hibid_sources.yml, fetches every
lot detail page, and writes a Parquet file in the same schema as scrape.py.

Usage:
    python scrape_hibid.py <catalog_url> --source <slug> [--company <name>]
    python scrape_hibid.py --discover-only   # just prints what would be scraped
"""

import argparse
import json
import re
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import requests
import yaml
from bs4 import BeautifulSoup
from categories import normalize_category, normalize_raw_with_description
from filters import (
    is_real_estate_auction,  # noqa: F401 (re-exported for test/back-compat)
)
from http_client import make_session
from persist import WriteContext, write_read_model
from scraper_common import has_bid_changes, load_existing_bids

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"
SOURCES_FILE = Path(__file__).resolve().parent / "hibid_sources.yml"

HIBID_BASE = "https://hibid.com"
REQUEST_DELAY = 0.5  # seconds between lot-page fetches

# HiBid serves a 200 placeholder page (not a real lot) when the auctioneer hides
# a lot or the listing is removed; the parsed title falls through to one of these
# markers. Treat such pages as a failed fetch so the dead lot is never persisted.
PLACEHOLDER_TITLES = {
    "lot unavailable",
    "404 not found",
    "page not found",
    "not found",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def hibid_safe_id(catalog_id: str | int) -> str:
    return f"hibid_{catalog_id}"


def company_location(slug: str, sources_file: Path | None = None) -> tuple[str, str]:
    """Resolve a company's ``location:`` ("City, ST") into ``(city, state)``.

    Discovery (``rescrape_all.py``) and this scraper run in separate processes —
    the child is only handed ``--source <slug>``, so it re-reads the config by
    slug here rather than threading a new CLI arg. Raises GeocodeError on an
    unknown slug or a missing/malformed location, which fails the scrape (the
    same loud gate as an unmapped city).
    """
    import geocode

    with open(sources_file or SOURCES_FILE) as f:
        config = yaml.safe_load(f)
    for company in config.get("companies", []):
        if company.get("slug") == slug:
            location = company.get("location", "")
            if not location:
                raise geocode.GeocodeError(
                    f"HiBid company {slug!r} has no 'location' in hibid_sources.yml"
                )
            return geocode.parse_location(location)
    raise geocode.GeocodeError(
        f"unknown HiBid company slug {slug!r} (not in hibid_sources.yml)"
    )


def extract_catalog_id(url: str) -> str | None:
    m = re.search(r"/catalog/(\d+)", url)
    return m.group(1) if m else None


def create_session() -> requests.Session:
    # HiBid occasionally serves a cert with a future not-before date during
    # rotation; disable verification rather than hard-failing the whole run.
    return make_session(verify=False)


def parse_date_range_end(text: str) -> str:
    """Extract the end date from 'M/D/YYYY - M/D/YYYY' and return ISO string."""
    m = re.search(
        r"(\d{1,2}/\d{1,2}/\d{4})\s*(?:[-–]|to)\s*(\d{1,2}/\d{1,2}/\d{4})",
        text,
    )
    if m:
        return _mdyyyy_to_iso(m.group(2))
    # Single date fallback
    m2 = re.search(r"(\d{1,2}/\d{1,2}/\d{4})", text)
    if m2:
        return _mdyyyy_to_iso(m2.group(1))
    return ""


def _mdyyyy_to_iso(date_str: str) -> str:
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            dt = datetime.strptime(date_str.strip(), fmt)
            # Fallback close time: 23:00 UTC when no time is scraped from the page
            return dt.replace(hour=23, minute=0, tzinfo=UTC).isoformat()
        except ValueError:
            continue
    return ""


def parse_relative_close_time(text: str, scraped_at: datetime) -> str:
    """Parse '1d 3h 24m ...' relative time string to ISO."""
    days = hours = mins = 0
    d = re.search(r"(\d+)\s*d", text)
    h = re.search(r"(\d+)\s*h", text)
    m = re.search(r"(\d+)\s*m", text)
    if d:
        days = int(d.group(1))
    if h:
        hours = int(h.group(1))
    if m:
        mins = int(m.group(1))
    if days + hours + mins == 0:
        return ""
    return (scraped_at + timedelta(days=days, hours=hours, minutes=mins)).isoformat()


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def discover_company_catalogs(
    session: requests.Session, company_id: int, html: str | None = None
) -> list[dict]:
    """Return active catalog dicts for a HiBid company.

    Pass pre-fetched ``html`` to skip the internal request (e.g. when the
    caller used Playwright to bypass bot protection).
    """
    if html is None:
        url = f"{HIBID_BASE}/company/{company_id}/"
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
        except Exception as exc:
            print(f"  Warning: could not fetch company page {company_id}: {exc}")
            return []
        html = resp.text

    soup = BeautifulSoup(html, "html.parser")
    catalogs: list[dict] = []
    seen_ids: set[str] = set()

    for a in soup.find_all("a", href=re.compile(r"/catalog/\d+")):
        href = a.get("href", "")
        m = re.search(r"/catalog/(\d+)", href)
        if not m:
            continue
        catalog_id = m.group(1)
        if catalog_id in seen_ids:
            continue
        seen_ids.add(catalog_id)

        # Find auction title from nearest heading in the card/row
        title = ""
        parent = a.find_parent(["div", "li", "article", "section", "tr"])
        if parent:
            for tag in ("h1", "h2", "h3", "h4", "h5"):
                h = parent.find(tag)
                if h:
                    title = h.get_text(strip=True)
                    break
        if not title:
            title = a.get_text(strip=True)
        # Strip trailing platform/status noise (e.g. "Online Only Auction", "Live Webcast")
        title = re.sub(
            r"\s*(Online Only|Live Webcast|Webcast|Timed)\s*Auction\s*$",
            "",
            title,
            flags=re.IGNORECASE,
        ).strip()

        # End date from "M/D/YYYY - M/D/YYYY" in the card text
        end_date_iso = ""
        if parent:
            end_date_iso = parse_date_range_end(parent.get_text(" ", strip=True))

        catalogs.append(
            {
                "catalog_id": catalog_id,
                "title": title,
                "end_date_iso": end_date_iso,
            }
        )

    return catalogs


def discover_hibid_specs(sources_file: Path | None = None) -> list[dict]:
    """Return {catalog_url, source_slug, company_name} for all active non-RE auctions.

    When a company entry has catalog_ids, those are used directly without fetching
    the company page (which is blocked by HiBid's bot protection on CI runners).
    Companies without catalog_ids fall back to live company-page discovery.
    """
    if sources_file is None:
        sources_file = SOURCES_FILE

    with open(sources_file) as f:
        config = yaml.safe_load(f)

    all_specs: list[dict] = []
    needs_discovery: list[dict] = []

    for company in config.get("companies", []):
        slug = company["slug"]
        name = company["name"]
        hardcoded_ids = company.get("catalog_ids") or []

        if hardcoded_ids:
            print(f"  {name}: using {len(hardcoded_ids)} hardcoded catalog(s)")
            for catalog_id in hardcoded_ids:
                catalog_url = f"{HIBID_BASE}/catalog/{catalog_id}/"
                all_specs.append(
                    {
                        "catalog_url": catalog_url,
                        "safe_id": hibid_safe_id(catalog_id),
                        "source_slug": slug,
                        "company_name": name,
                        "title": "",
                    }
                )
        else:
            needs_discovery.append(company)

    if needs_discovery:
        session = create_session()
        for company in needs_discovery:
            company_id = company["id"]
            slug = company["slug"]
            name = company["name"]
            print(f"  Discovering {name} (HiBid #{company_id})...")
            catalogs = discover_company_catalogs(session, company_id)
            for cat in catalogs:
                if is_real_estate_auction(cat.get("title", "")):
                    print(f"    Skipping real estate: {cat['title'][:60]}")
                    continue
                catalog_url = f"{HIBID_BASE}/catalog/{cat['catalog_id']}/"
                all_specs.append(
                    {
                        "catalog_url": catalog_url,
                        "safe_id": hibid_safe_id(cat["catalog_id"]),
                        "source_slug": slug,
                        "company_name": name,
                        "title": cat["title"],
                    }
                )
                print(f"    Found: {cat['title'][:60]}")

    return all_specs


# ---------------------------------------------------------------------------
# Catalog pagination
# ---------------------------------------------------------------------------


def _parse_apollo_state(html: str) -> dict:
    """Extract the hibid-state Apollo cache JSON from a page."""
    m = re.search(r'<script id="hibid-state"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1)).get("apollo.state", {})
    except Exception:
        return {}


def _lot_links_from_html(html: str) -> list[tuple[str, int]]:
    """Extract lot specs from already-fetched catalog page HTML."""
    apollo = _parse_apollo_state(html)

    lots_in_state: dict[int, int] = {}
    for k, v in apollo.items():
        if k.startswith("Lot:") and isinstance(v, dict):
            try:
                lot_id = int(k.split(":")[1])
                lot_num = int(v.get("lotNumber") or 0)
                lots_in_state[lot_id] = lot_num
            except (ValueError, TypeError):
                continue

    rq = apollo.get("ROOT_QUERY", {})
    lot_search_key = next((k for k in rq if k.startswith("lotSearch")), None)
    total_count = 0
    if lot_search_key:
        pr = rq[lot_search_key].get("pagedResults") or {}
        total_count = pr.get("totalCount") or 0

    if lots_in_state and total_count > 0:
        min_id = min(lots_in_state)
        min_lot_num = lots_in_state[min_id]
        base_id = min_id - (min_lot_num - 1)
        return [
            (f"{HIBID_BASE}/lot/{base_id + lot_num - 1}/", lot_num)
            for lot_num in range(1, total_count + 1)
        ]

    # Fallback: parse links directly from HTML (capped at 100)
    print("  Warning: Apollo state unavailable; falling back to HTML lot links")
    soup = BeautifulSoup(html, "html.parser")
    seen_ids: set[str] = set()
    lot_links: list[tuple[str, int]] = []
    for a in soup.find_all("a", href=re.compile(r"/lot/\d+")):
        href = a.get("href", "").split("?")[0]
        m = re.search(r"/lot/(\d+)", href)
        if not m:
            continue
        lot_id = m.group(1)
        if lot_id in seen_ids:
            continue
        seen_ids.add(lot_id)
        link_text = a.get_text(strip=True)
        lot_num = 0
        lot_m = re.match(r"Lot\s*#?\s*(\d+)", link_text, re.IGNORECASE)
        if lot_m:
            lot_num = int(lot_m.group(1))
        full_url = href if href.startswith("http") else HIBID_BASE + href
        lot_links.append((full_url, lot_num))
    lot_links.sort(key=lambda x: (x[1] == 0, x[1]))
    return lot_links


def fetch_catalog_lot_links(
    session: requests.Session,
    catalog_url: str,
    html: str | None = None,
) -> list[tuple[str, int]]:
    """Return [(full_lot_url, lot_number_hint), ...] for every lot in the catalog."""
    if html is None:
        base_url = catalog_url.rstrip("/")
        try:
            resp = session.get(base_url + "/", timeout=30)
            resp.raise_for_status()
            html = resp.text
        except Exception as exc:
            print(f"  Warning: catalog page fetch failed: {exc}")
            return []
    return _lot_links_from_html(html)


# ---------------------------------------------------------------------------
# Lot detail page parsing
# ---------------------------------------------------------------------------


def fetch_lot_details(
    session: requests.Session,
    lot_url: str,
    auction_end_date: str,
    scraped_at: datetime,
) -> dict | None:
    """Fetch one lot detail page and return an item dict."""
    try:
        resp = session.get(lot_url, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"    Warning: lot fetch failed {lot_url}: {exc}")
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    text = soup.get_text(" ", strip=True)

    # Item ID
    lot_id_m = re.search(r"/lot/(\d+)", lot_url)
    item_id = f"hibid_{lot_id_m.group(1)}" if lot_id_m else lot_url

    # Lot number
    lot_number = 0
    lot_m = re.search(r"Lot\s*#\s*[:\-]?\s*(\d+)", text, re.IGNORECASE)
    if lot_m:
        lot_number = int(lot_m.group(1))

    # Title — strip HiBid's "Lot # : N -" prefix that appears in some h1 tags
    title = ""
    h1 = soup.find("h1")
    if h1:
        title = h1.get_text(strip=True)
        title = re.sub(
            r"^Lot\s*#\s*[:\-]?\s*\d+\s*[-–]\s*", "", title, flags=re.IGNORECASE
        ).strip()
    if not title:
        og = soup.find("meta", property="og:title")
        if og:
            title = og.get("content", "").strip()
    if not title:
        t = soup.find("title")
        if t:
            title = t.get_text(strip=True).split("|")[0].strip()

    # Skip placeholder/error pages (auctioneer-hidden or removed lots): HiBid
    # returns these with a 200 status, so raise_for_status doesn't catch them.
    if not title or title.strip().lower() in PLACEHOLDER_TITLES:
        return None

    # Description — truncate at common boilerplate markers
    description = ""
    for sel in [
        ".lot-description",
        ".description",
        "[class*='description']",
        ".item-details",
        ".detail-body",
        ".catalog-item-details",
    ]:
        el = soup.select_one(sel)
        if el:
            description = el.get_text(strip=True)
            break
    if not description:
        desc_m = re.search(r"Description[:\s]+([^\n]{10,400})", text, re.IGNORECASE)
        if desc_m:
            description = desc_m.group(1).strip()
    # Strip boilerplate that follows the actual description
    for marker in (
        "Auction Information",
        "Bidding Opens",
        "Auction Closing",
        "Terms & Conditions",
    ):
        idx = description.find(marker)
        if idx > 0:
            description = description[:idx].strip()
    description = description[:500]

    # Current bid (live auctions) or realized price (closed auctions). Once a
    # HiBid auction closes the "High Bid" field disappears and the hammer price
    # is shown as "Price Realized: N USD" instead — capture either so backfilled
    # closed lots carry their final sold price.
    current_bid = 0.0
    bid_m = re.search(
        r"High\s*Bid\s*[:\-]?\s*\$?\s*([\d,]+\.?\d*)\s*USD",
        text,
        re.IGNORECASE,
    )
    if bid_m:
        current_bid = float(bid_m.group(1).replace(",", ""))
    if not current_bid:
        realized_m = re.search(
            r"Price\s+Realized\s*[:\-]?\s*\$?\s*([\d,]+\.?\d*)\s*USD",
            text,
            re.IGNORECASE,
        )
        if realized_m:
            current_bid = float(realized_m.group(1).replace(",", ""))

    # Total bids
    total_bids = 0
    bids_m = re.search(r"(\d+)\s*Bids?", text, re.IGNORECASE)
    if bids_m:
        total_bids = int(bids_m.group(1))

    # Extract breadcrumb categories. HiBid's last breadcrumb crumb is always the
    # lot title — skip it and any long strings. The most specific remaining crumb
    # is used as raw_cat so HiBid items flow through the shared raw_aliases layer;
    # all crumbs are also folded into `combined` for keyword-inference fallback.
    cat_crumbs: list[str] = []
    for nav_sel in [
        "nav[aria-label*='breadcrumb' i]",
        ".breadcrumb",
        "[class*='breadcrumb']",
    ]:
        nav = soup.select_one(nav_sel)
        if nav:
            skip_lower = {
                "home",
                "auctions",
                "lots",
                "catalog",
                "all auctions",
                "virginia",
            }
            cat_crumbs = [
                a.get_text(strip=True)
                for a in nav.find_all("a")
                if a.get_text(strip=True).lower() not in skip_lower
                and len(a.get_text(strip=True)) <= 40  # lot titles are longer
            ]
            break
    breadcrumb_extra = " ".join(cat_crumbs)
    raw_cat = " > ".join(cat_crumbs) if cat_crumbs else ""

    # Images — HiBid loads the gallery via JS, but the primary photo is in og:image
    images: list[str] = []
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content"):
        images.append(og_img["content"])
    # Also check og:image:secure_url and twitter:image as fallbacks
    for prop in ("og:image:secure_url", "twitter:image"):
        meta = soup.find("meta", property=prop) or soup.find(
            "meta", attrs={"name": prop}
        )
        if meta and meta.get("content") and meta["content"] not in images:
            images.append(meta["content"])
            break

    # Per-lot end date: try to parse relative time, fall back to auction end date
    end_date = auction_end_date
    rel_m = re.search(r"(\d+d\s*)?(\d+h\s*)?\d+m\s*[-–]", text)
    if rel_m:
        parsed = parse_relative_close_time(
            rel_m.group(0).replace("-", "").replace("–", ""), scraped_at
        )
        if parsed:
            end_date = parsed

    combined = (breadcrumb_extra + " " + title + " " + description).strip()
    return {
        "id": item_id,
        "lotNumber": lot_number,
        "title": title,
        "description": description,
        "currentBid": current_bid,
        "totalBids": total_bids,
        "endDate": end_date,
        "images": images,
        "category": normalize_category(raw_cat, combined, source="hibid"),
        "rawCategory": normalize_raw_with_description(
            raw_cat, combined, source="hibid"
        ),
        "detailUrl": lot_url,
    }


# ---------------------------------------------------------------------------
# Main scrape function
# ---------------------------------------------------------------------------


def scrape_hibid_auction(
    catalog_url: str,
    source_slug: str,
    company_name: str,
    snapshot_to_motherduck: bool | None = None,
) -> dict:
    """Scrape one HiBid catalog and write Parquet. Returns {changed, count}."""
    catalog_id = extract_catalog_id(catalog_url)
    if not catalog_id:
        raise ValueError(f"Cannot extract catalog ID from: {catalog_url}")

    safe_id = hibid_safe_id(catalog_id)
    print(f"Scraping HiBid catalog {catalog_id} ({company_name})")

    session = create_session()
    scraped_at = datetime.now(UTC)

    # Canonical catalog URL (no state prefix)
    full_catalog_url = f"{HIBID_BASE}/catalog/{catalog_id}/"

    # Fetch catalog page once: parse title, end date, and lot specs together.
    auction_title = ""
    auction_end_date = ""
    catalog_html = ""
    try:
        resp = session.get(full_catalog_url, timeout=30)
        resp.raise_for_status()
        catalog_html = resp.text
    except Exception as exc:
        print(f"  Warning: could not load catalog page: {exc}")

    if catalog_html:
        # Try Apollo state first for clean title/date (strips the " | HiBid.com" suffix)
        apollo = _parse_apollo_state(catalog_html)
        auction_obj = apollo.get(f"Auction:{catalog_id}") or {}
        auction_title = auction_obj.get("title", "")
        auction_end_date = auction_obj.get("endDate", "")

        if not auction_title or not auction_end_date:
            soup = BeautifulSoup(catalog_html, "html.parser")
            page_text = soup.get_text(" ", strip=True)
            if not auction_title:
                h1 = soup.find("h1")
                if h1:
                    auction_title = h1.get_text(strip=True)
            if not auction_title:
                og = soup.find("meta", property="og:title")
                if og:
                    auction_title = og.get("content", "").split("|")[0].strip()
            if not auction_title:
                t = soup.find("title")
                if t:
                    auction_title = t.get_text(strip=True).split("|")[0].strip()
            if not auction_end_date:
                auction_end_date = parse_date_range_end(page_text)

    print(f"  Title: {auction_title or '(unknown — will derive from lots)'}")
    print(f"  End date: {auction_end_date or '(unknown)'}")

    if is_real_estate_auction(auction_title):
        print("  Skipping: real estate auction")
        return {"changed": False, "skipped": True}

    # Pass the already-fetched HTML so fetch_catalog_lot_links skips a second request.
    print("  Fetching lot links...")
    lot_specs = fetch_catalog_lot_links(
        session, full_catalog_url, html=catalog_html or None
    )
    print(f"  Found {len(lot_specs)} lots")

    if not lot_specs:
        print("  No lots found; skipping")
        return {"changed": False}

    # Fetch each lot detail page
    all_items: list[dict] = []
    for i, (lot_url, lot_num_hint) in enumerate(lot_specs, 1):
        if i > 1:
            time.sleep(REQUEST_DELAY)
        print(f"  Fetching lot {i}/{len(lot_specs)}...", end="\r")
        item = fetch_lot_details(session, lot_url, auction_end_date, scraped_at)
        if item:
            if lot_num_hint and not item["lotNumber"]:
                item["lotNumber"] = lot_num_hint
            all_items.append(item)

    print(f"  Fetched {len(all_items)} lots          ")

    if not all_items:
        print("  No items parsed; skipping")
        return {"changed": False}

    # Derive auction-level metadata from items when catalog page parsing failed
    if not auction_title:
        auction_title = catalog_url
    if not auction_end_date:
        dates = [item["endDate"] for item in all_items if item.get("endDate")]
        if dates:
            auction_end_date = max(dates)

    # Skip write if nothing changed
    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    existing_bids = load_existing_bids(items_path)
    if not has_bid_changes(all_items, existing_bids):
        print(f"  No bid changes; skipping write for {safe_id}")
        return {"changed": False}

    auction_city, auction_state = company_location(source_slug)
    ctx = WriteContext(
        safe_id=safe_id,
        auction_id=catalog_id,
        auction_title=auction_title,
        auction_end_date=auction_end_date,
        source=source_slug,
        source_url=catalog_url,
        scraped_at=scraped_at.isoformat(),
        session=session,
        snapshot_to_motherduck=snapshot_to_motherduck,
        auction_city=auction_city,
        auction_state=auction_state,
    )
    return write_read_model(all_items, ctx)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape a HiBid auction catalog")
    parser.add_argument(
        "catalog_url",
        nargs="?",
        help="HiBid catalog URL (e.g. https://hibid.com/catalog/744897/...)",
    )
    parser.add_argument("--source", default="hibid", help="Company slug")
    parser.add_argument("--company", default="", help="Display name of the company")
    parser.add_argument(
        "--discover-only",
        action="store_true",
        help="Print what would be scraped and exit",
    )
    parser.add_argument("--motherduck", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args(sys.argv[1:])

    if args.discover_only:
        print("Discovering HiBid auctions...")
        specs = discover_hibid_specs()
        print(f"\nFound {len(specs)} auction(s):")
        for spec in specs:
            print(f"  [{spec['source_slug']}] {spec['title'][:60]}")
            print(f"    {spec['catalog_url']}")
        sys.exit(0)

    if not args.catalog_url:
        print(
            "Error: catalog_url is required unless --discover-only is used",
            file=sys.stderr,
        )
        sys.exit(1)

    scrape_hibid_auction(
        args.catalog_url,
        source_slug=args.source,
        company_name=args.company or args.source,
        snapshot_to_motherduck=args.motherduck or None,
    )
