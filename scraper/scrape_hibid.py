#!/usr/bin/env python3
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import requests
import yaml
from bs4 import BeautifulSoup

from categories import normalize_category, normalize_raw_with_description

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"
SOURCES_FILE = Path(__file__).resolve().parent / "hibid_sources.yml"

HIBID_BASE = "https://hibid.com"
REQUEST_DELAY = 0.5  # seconds between lot-page fetches

REAL_ESTATE_KEYWORDS = [
    "real estate",
    "property auction",
    "land auction",
    "land sale",
    "parcel",
    "acres",
    "foreclosure",
    "tax sale",
    "tax auction",
    "deed",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_real_estate_auction(title: str) -> bool:
    lower = title.lower()
    return any(kw in lower for kw in REAL_ESTATE_KEYWORDS)


def hibid_safe_id(catalog_id: str | int) -> str:
    return f"hibid_{catalog_id}"


def extract_catalog_id(url: str) -> str | None:
    m = re.search(r"/catalog/(\d+)", url)
    return m.group(1) if m else None


def create_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    })
    return session


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
            return dt.replace(hour=23, minute=0, tzinfo=timezone.utc).isoformat()
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
    session: requests.Session, company_id: int
) -> list[dict]:
    """Return active catalog dicts for a HiBid company."""
    url = f"{HIBID_BASE}/company/{company_id}/"
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Warning: could not fetch company page {company_id}: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
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
        title = re.sub(r"\s*(Online Only|Live Webcast|Webcast|Timed)\s*Auction\s*$", "", title, flags=re.IGNORECASE).strip()

        # End date from "M/D/YYYY - M/D/YYYY" in the card text
        end_date_iso = ""
        if parent:
            end_date_iso = parse_date_range_end(parent.get_text(" ", strip=True))

        catalogs.append({
            "catalog_id": catalog_id,
            "title": title,
            "end_date_iso": end_date_iso,
        })

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
                all_specs.append({
                    "catalog_url": catalog_url,
                    "safe_id": hibid_safe_id(catalog_id),
                    "source_slug": slug,
                    "company_name": name,
                    "title": "",
                })
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
                all_specs.append({
                    "catalog_url": catalog_url,
                    "safe_id": hibid_safe_id(cat["catalog_id"]),
                    "source_slug": slug,
                    "company_name": name,
                    "title": cat["title"],
                })
                print(f"    Found: {cat['title'][:60]}")

    return all_specs


# ---------------------------------------------------------------------------
# Catalog pagination
# ---------------------------------------------------------------------------

def fetch_catalog_lot_links(
    session: requests.Session, catalog_url: str
) -> list[tuple[str, int]]:
    """
    Return [(full_lot_url, lot_number_hint), ...] for every lot in the catalog.
    Paginates until no more lot links are found.
    """
    lot_links: list[tuple[str, int]] = []
    seen_ids: set[str] = set()
    base_url = catalog_url.rstrip("/")
    page = 1

    while page <= 50:
        page_url = base_url if page == 1 else f"{base_url}?page={page}"
        try:
            resp = session.get(page_url, timeout=30)
            resp.raise_for_status()
        except Exception as exc:
            print(f"  Warning: catalog page {page} failed: {exc}")
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        links = soup.find_all("a", href=re.compile(r"/lot/\d+"))
        if not links:
            break

        added = 0
        for a in links:
            href = a.get("href", "").split("?")[0]
            m = re.search(r"/lot/(\d+)", href)
            if not m:
                continue
            lot_id = m.group(1)
            if lot_id in seen_ids:
                continue
            seen_ids.add(lot_id)

            # "Lot 3 | Title" → extract lot number
            link_text = a.get_text(strip=True)
            lot_num = 0
            lot_m = re.match(r"Lot\s*#?\s*(\d+)", link_text, re.IGNORECASE)
            if lot_m:
                lot_num = int(lot_m.group(1))

            full_url = href if href.startswith("http") else HIBID_BASE + href
            lot_links.append((full_url, lot_num))
            added += 1

        if added == 0:
            break

        next_link = soup.find("a", string=re.compile(r"Next|›|»", re.IGNORECASE))
        if not next_link:
            break
        page += 1

    lot_links.sort(key=lambda x: (x[1] == 0, x[1]))
    return lot_links


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
        title = re.sub(r"^Lot\s*#\s*[:\-]?\s*\d+\s*[-–]\s*", "", title, flags=re.IGNORECASE).strip()
    if not title:
        og = soup.find("meta", property="og:title")
        if og:
            title = og.get("content", "").strip()
    if not title:
        t = soup.find("title")
        if t:
            title = t.get_text(strip=True).split("|")[0].strip()

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
        desc_m = re.search(
            r"Description[:\s]+([^\n]{10,400})", text, re.IGNORECASE
        )
        if desc_m:
            description = desc_m.group(1).strip()
    # Strip boilerplate that follows the actual description
    for marker in ("Auction Information", "Bidding Opens", "Auction Closing", "Terms & Conditions"):
        idx = description.find(marker)
        if idx > 0:
            description = description[:idx].strip()
    description = description[:500]

    # Current bid
    current_bid = 0.0
    bid_m = re.search(
        r"High\s*Bid\s*[:\-]?\s*\$?\s*([\d,]+\.?\d*)\s*USD",
        text,
        re.IGNORECASE,
    )
    if bid_m:
        current_bid = float(bid_m.group(1).replace(",", ""))

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
            skip_lower = {"home", "auctions", "lots", "catalog", "all auctions", "virginia"}
            cat_crumbs = [
                a.get_text(strip=True)
                for a in nav.find_all("a")
                if a.get_text(strip=True).lower() not in skip_lower
                and len(a.get_text(strip=True)) <= 40  # lot titles are longer
            ]
            break
    breadcrumb_extra = " ".join(cat_crumbs)
    raw_cat = cat_crumbs[-1] if cat_crumbs else ""

    # Images — HiBid loads the gallery via JS, but the primary photo is in og:image
    images: list[str] = []
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content"):
        images.append(og_img["content"])
    # Also check og:image:secure_url and twitter:image as fallbacks
    for prop in ("og:image:secure_url", "twitter:image"):
        meta = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
        if meta and meta.get("content") and meta["content"] not in images:
            images.append(meta["content"])
            break

    # Per-lot end date: try to parse relative time, fall back to auction end date
    end_date = auction_end_date
    rel_m = re.search(r"(\d+d\s*)?(\d+h\s*)?\d+m\s*[-–]", text)
    if rel_m:
        parsed = parse_relative_close_time(rel_m.group(0).replace("-", "").replace("–", ""), scraped_at)
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
        "category": normalize_category(raw_cat, combined),
        "rawCategory": normalize_raw_with_description(raw_cat, combined),
        "detailUrl": lot_url,
    }


# ---------------------------------------------------------------------------
# Bid-change detection (mirrors scrape.py)
# ---------------------------------------------------------------------------

def load_existing_bids(path: Path) -> dict[str, tuple[float, int]]:
    if not path.exists():
        return {}
    try:
        table = pq.read_table(path, columns=["id", "currentBid", "totalBids"])
        return {
            row["id"]: (float(row["currentBid"] or 0), int(row["totalBids"] or 0))
            for row in table.to_pylist()
        }
    except Exception:
        return {}


def has_bid_changes(new_items: list[dict], existing_bids: dict) -> bool:
    if not existing_bids:
        return True
    new_ids = {item["id"] for item in new_items}
    if new_ids != set(existing_bids):
        return True
    return any(
        (float(item.get("currentBid") or 0), int(item.get("totalBids") or 0))
        != existing_bids.get(item["id"])
        for item in new_items
    )


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
    scraped_at = datetime.now(timezone.utc)

    # Canonical catalog URL (no state prefix)
    full_catalog_url = f"{HIBID_BASE}/catalog/{catalog_id}/"

    # Fetch catalog page: title + end date
    auction_title = ""
    auction_end_date = ""
    try:
        resp = session.get(full_catalog_url, timeout=30)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        page_text = soup.get_text(" ", strip=True)

        h1 = soup.find("h1")
        if h1:
            auction_title = h1.get_text(strip=True)
        if not auction_title:
            og = soup.find("meta", property="og:title")
            if og:
                auction_title = og.get("content", "").split("|")[0].strip()

        auction_end_date = parse_date_range_end(page_text)
    except Exception as exc:
        print(f"  Warning: could not load catalog page: {exc}")

    if not auction_title:
        auction_title = catalog_url
    print(f"  Title: {auction_title}")
    print(f"  End date: {auction_end_date or '(unknown)'}")

    if is_real_estate_auction(auction_title):
        print("  Skipping: real estate auction")
        return {"changed": False, "skipped": True}

    # Fetch lot links
    print("  Fetching lot links...")
    lot_specs = fetch_catalog_lot_links(session, full_catalog_url)
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

    # Skip write if nothing changed
    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    existing_bids = load_existing_bids(items_path)
    if not has_bid_changes(all_items, existing_bids):
        print(f"  No bid changes; skipping write for {safe_id}")
        import os
        if os.environ.get("GOONERS_EMBEDDINGS") == "1":
            emb_path = items_path.with_suffix(".embeddings")
            if not emb_path.exists():
                print(f"  Embeddings missing for {safe_id}; generating now")
                from embed import generate_and_write as _gen_embeddings
                _gen_embeddings(all_items, items_path, None)
        return {"changed": False}

    ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    scraped_at_str = scraped_at.isoformat()

    for item in all_items:
        item["auctionId"] = catalog_id
        item["auctionSafeId"] = safe_id
        item["auctionTitle"] = auction_title
        item["auctionEndDate"] = auction_end_date
        item["scrapedAt"] = scraped_at_str
        item["source"] = source_slug

    # Write NDJSON (images as real array)
    ndjson_path = ITEMS_DIR / f"{safe_id}.ndjson"
    ndjson_lines = [json.dumps(item, separators=(',', ':')) for item in all_items]
    ndjson_path.write_text('\n'.join(ndjson_lines) + '\n', encoding='utf-8')
    print(f"  Wrote {len(all_items)} items → {ndjson_path.name}")

    # Generate CLIP embeddings (images still arrays at this point)
    import os
    if os.environ.get("GOONERS_EMBEDDINGS") == "1":
        from embed import generate_and_write as _gen_embeddings
        _gen_embeddings(all_items, items_path, None)

    # Write Parquet (images stringified for Arrow compatibility)
    for item in all_items:
        item["images"] = json.dumps(item["images"])
    table = pa.Table.from_pylist(all_items)
    pq.write_table(table, items_path, compression="snappy")
    print(f"  Wrote {len(all_items)} items → {items_path.name}")

    if snapshot_to_motherduck is None:
        from motherduck import should_snapshot_to_motherduck
        snapshot_to_motherduck = should_snapshot_to_motherduck()

    if snapshot_to_motherduck:
        from warehouse import get_sink
        sink = get_sink()
        if sink is not None:
            snapshot_count = sink.append_listing_snapshots(all_items, catalog_url)
            print(f"  Appended {snapshot_count} listing snapshots to the warehouse")

    return {"changed": True, "count": len(all_items)}


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
    parser.add_argument("--discover-only", action="store_true", help="Print what would be scraped and exit")
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
        print("Error: catalog_url is required unless --discover-only is used", file=sys.stderr)
        sys.exit(1)

    scrape_hibid_auction(
        args.catalog_url,
        source_slug=args.source,
        company_name=args.company or args.source,
        snapshot_to_motherduck=args.motherduck or None,
    )
