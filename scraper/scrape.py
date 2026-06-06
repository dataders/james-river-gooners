#!/usr/bin/env python3
"""
Cannon's Auctions scraper.

Fetches auction item data from the Maxanet platform and outputs clean JSON.
Usage: python scrape.py <auction_url>
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

import requests
from bs4 import BeautifulSoup

from categories import normalize_category, normalize_raw_with_description
from scraper_common import has_bid_changes, load_existing_bids, load_existing_unique_bidders


DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"

# Polite delay between per-lot bid-history fetches (only hit for changed lots).
BID_HISTORY_DELAY = 0.25


def sanitize_auction_id(auction_id: str) -> str:
    """Convert base64 auction ID to filesystem-safe string."""
    return auction_id.replace("+", "-").replace("/", "_").replace("=", "")


def count_unique_bidders(html: str) -> int:
    """Count distinct (masked) bidder IDs in a GetBidlist HTML fragment.

    Cannon's masks bidder IDs like ``4***2``; the first column of each bid-history
    row is the bidder who placed that bid. Distinct masks ≈ distinct bidders.
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    if not table:
        return 0
    body = table.find("tbody") or table
    bidders: set[str] = set()
    for tr in body.find_all("tr"):
        cells = tr.find_all("td")
        if not cells:
            continue
        bidder = cells[0].get_text(strip=True)
        if bidder:
            bidders.add(bidder)
    return len(bidders)


def fetch_unique_bidders(session: requests.Session, item_id: str) -> int | None:
    """Fetch a lot's bid history and return its distinct-bidder count (None on failure)."""
    url = "https://bid.cannonsauctions.com/Public/Auction/GetBidlist"
    params = {
        "AuctionItemId": item_id,
        "NameSearch": "",
        "pageNumber": 1,
        "pageSize": 1000,  # one page covers any realistic lot's full history
    }
    try:
        resp = session.get(
            url,
            params=params,
            headers={"X-Requested-With": "XMLHttpRequest"},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"  Warning: bid history fetch failed for item {item_id}: {exc}")
        return None
    return count_unique_bidders(resp.text)


def enrich_unique_bidders(
    session: requests.Session,
    items: list[dict],
    existing_bids: dict[str, tuple[float, int]],
    existing_unique: dict[str, int],
) -> None:
    """Populate ``item['uniqueBidders']`` in place for Cannon's lots.

    Lots with no bids get 0 without a network call. For bidding lots we reuse the
    prior count when the bid total is unchanged, and only fetch bid history for
    lots that are new or whose bid count moved since the last scrape.
    """
    fetched = 0
    for item in items:
        item_id = item["id"]
        total = int(item.get("totalBids") or 0)
        if total <= 0:
            item["uniqueBidders"] = 0
            continue

        prior = existing_bids.get(item_id)
        prior_total = prior[1] if prior else None
        prior_unique = existing_unique.get(item_id)
        if prior_unique is not None and prior_total == total:
            item["uniqueBidders"] = prior_unique
            continue

        if fetched:
            time.sleep(BID_HISTORY_DELAY)
        count = fetch_unique_bidders(session, item_id)
        fetched += 1
        if count is not None:
            item["uniqueBidders"] = count
        elif prior_unique is not None:
            item["uniqueBidders"] = prior_unique
        # else: leave unset so the field is simply absent for this lot

    if fetched:
        print(f"Fetched bid history for {fetched} lot(s)")


def auction_date_from_title(title: str) -> str:
    """Derive an auction end date from a Cannon's auction title.

    Closed auction item cards carry no live countdown, so their per-lot
    ``endDate`` is blank. Cannon's titles are prefixed with the auction date,
    e.g. ``"06/04/26: Children's Museum of Richmond | ..."``. Return that date
    at end-of-day in a ``%Y-%m-%d %H:%M:%S`` string (parsed as Eastern by
    ``dates.py``) so backfilled closed auctions still sort and archive
    correctly. Returns ``""`` when no leading date is found.
    """
    match = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{2,4})", title or "")
    if not match:
        return ""
    month, day, year = (int(part) for part in match.groups())
    if year < 100:
        year += 2000
    try:
        datetime(year, month, day)
    except ValueError:
        return ""
    return f"{year:04d}-{month:02d}-{day:02d} 23:59:59"


def extract_auction_id(url: str) -> str:
    """Extract AuctionId parameter from a Cannon's auction URL."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    if "AuctionId" in params:
        return unquote(params["AuctionId"][0])
    raise ValueError(f"No AuctionId found in URL: {url}")


def create_session(auction_url: str) -> tuple[requests.Session, str]:
    """Create a requests session with proper cookies. Returns (session, page_html)."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    })
    # Visit the auction page to establish session cookies
    resp = session.get(auction_url, allow_redirects=True, timeout=30)
    resp.raise_for_status()
    return session, resp.text


def fetch_categories(session: requests.Session, auction_id: str) -> dict:
    """Fetch category list from Maxanet API. Returns {id: name} dict."""
    url = f"https://bid.cannonsauctions.com/Public/Lookup/GetCategories"
    resp = session.get(url, params={"AuctionId": auction_id}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return {item["Value"]: item["Text"].strip() for item in data if item.get("Text", "").strip()}


def fetch_items_page(session: requests.Session, auction_id: str, page: int, page_size_token: str) -> str:
    """Fetch a single page of auction items (returns HTML fragment)."""
    url = "https://bid.cannonsauctions.com/Public/Auction/GetAuctionItems"
    params = {
        "aucId": auction_id,
        "pageNumber": page,
        "viewType": 2,  # grid view
        "Categoryfilter": "",
        "ShowFilter": "all",
        "SortBy": "ordernumber_asc",
        "SearchFilter": "",
        "pageSize": page_size_token,
        "Filter": "",
        "oldPageNumber": "",
    }
    resp = session.get(
        url,
        params=params,
        headers={"X-Requested-With": "XMLHttpRequest"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.text


def extract_page_size_token(html: str) -> str:
    """Extract the encrypted pageSize token from the auction page HTML."""
    match = re.search(r'var items\s*=\s*"([^"]+)"', html)
    if match:
        return match.group(1)
    raise ValueError("Could not find pageSize token in page HTML")


def extract_total_pages(html: str) -> int:
    """Extract total page count from items HTML."""
    soup = BeautifulSoup(html, "html.parser")
    total_pages_input = soup.find("input", {"id": "Pager_TotalPages"})
    if total_pages_input and total_pages_input.get("value"):
        return int(total_pages_input["value"])
    return 1


def extract_auction_title(html: str) -> str:
    """Extract auction title from the main page."""
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.find("h3", class_="auction-title")
    if title_el:
        return title_el.get_text(strip=True)
    # Fallback: look in meta or title
    title_tag = soup.find("title")
    if title_tag:
        return title_tag.get_text(strip=True)
    return "Unknown Auction"


def parse_items_html(html: str, categories_map: dict) -> list[dict]:
    """Parse auction items from the GetAuctionItems HTML response."""
    soup = BeautifulSoup(html, "html.parser")
    items = []

    # Find all item cards - they use class "col-lg-4" inside the items container
    cards = soup.find_all("div", class_="auction-item-card-color")
    if not cards:
        # Try alternate selector
        cards = soup.select(".col-lg-4")

    for card in cards:
        item = parse_single_card(card, categories_map)
        if item:
            items.append(item)

    return items


def parse_single_card(card, categories_map: dict) -> dict | None:
    """Parse a single auction item card into a dict."""
    # Item ID from BidAuctionItemId hidden input
    bid_input = card.find("input", class_="BidAuctionItemId")
    if not bid_input:
        bid_input = card.find("input", attrs={"name": lambda n: n and "BidAuctionItemId" in str(n)})
    item_id = bid_input["value"] if bid_input else None
    if not item_id:
        return None

    # Title from auction-lot-title link
    title_link = card.select_one(".auction-lot-title a, h4.auction-ItemGrid-Title a")
    title = title_link.get_text(strip=True) if title_link else ""

    # Description
    desc_el = card.select_one(".catelog-desc")
    description = desc_el.get_text(strip=True) if desc_el else ""

    # Current bid amount
    bid_el = card.select_one('span[id^="CurrentBidAmount_"]')
    bid_text = bid_el.get_text(strip=True) if bid_el else "$0"
    current_bid = float(re.sub(r"[^\d.]", "", bid_text) or "0")

    # Also check hidden input for more accurate value
    bid_val_input = card.find("input", attrs={"name": lambda n: n and str(n).startswith("CurrentAmount_")})
    if bid_val_input and bid_val_input.get("value"):
        try:
            current_bid = float(bid_val_input["value"])
        except ValueError:
            pass

    # Total bids
    bids_input = card.find("input", attrs={"name": "TotalBids"})
    total_bids = int(bids_input["value"]) if bids_input and bids_input.get("value") else 0

    # End date
    timer_el = card.select_one(".remain-time")
    end_date = timer_el.get("data-enddate", "") if timer_el else ""

    # Images from carousel
    images = []
    img_els = card.select(".carousel-item img")
    for img in img_els:
        src = img.get("src", "")
        if src and "s3.amazonaws.com" in src:
            images.append(src)

    # Category from hidden Types input
    cat_input = card.find("input", attrs={"name": lambda n: n and str(n).startswith("Types")})
    raw_category = cat_input["value"] if cat_input else ""
    category = normalize_category(raw_category, source="cannons")

    # Detail URL
    detail_link = card.select_one('a[href*="AuctionItemDetail"]')
    detail_url = ""
    if detail_link:
        href = detail_link.get("href", "")
        if href.startswith("/"):
            detail_url = f"https://bid.cannonsauctions.com{href}"
        else:
            detail_url = href

    # Lot number from the order
    lot_el = card.select_one("span.public-item-font-color")
    lot_text = lot_el.get_text(strip=True) if lot_el else ""
    lot_match = re.search(r"(\d+)", lot_text)
    lot_number = int(lot_match.group(1)) if lot_match else 0

    return {
        "id": item_id,
        "lotNumber": lot_number,
        "title": title,
        "description": description[:500],  # Truncate long descriptions
        "currentBid": current_bid,
        "totalBids": total_bids,
        # Final/sold-price tracking (#94). Live lots are open: closed=False and
        # finalBid=None. The archive step stamps finalBid (= last-seen
        # currentBid) and closed=True when an auction actually closes.
        "closed": False,
        "finalBid": None,
        "endDate": end_date,
        "images": images[:5],  # Keep first 5 images
        "category": normalize_category(raw_category, description, source="cannons"),
        "rawCategory": normalize_raw_with_description(raw_category, description, source="cannons"),
        "detailUrl": detail_url,
    }


def scrape_auction(auction_url: str, snapshot_to_motherduck: bool | None = None) -> None:
    """Main scrape function for a single auction."""
    auction_id = extract_auction_id(auction_url)
    safe_id = sanitize_auction_id(auction_id)

    print(f"Scraping auction: {auction_id}")
    print(f"Safe filename ID: {safe_id}")

    # Create session (also fetches the page)
    session, main_html = create_session(auction_url)
    print("Session established")
    page_size_token = extract_page_size_token(main_html)
    auction_title = extract_auction_title(main_html)
    print(f"Auction: {auction_title}")
    print(f"Page size token: {page_size_token}")

    # Fetch categories
    categories_map = fetch_categories(session, auction_id)
    print(f"Found {len(categories_map)} categories")

    # Fetch first page to get total pages
    first_page_html = fetch_items_page(session, auction_id, 1, page_size_token)
    total_pages = extract_total_pages(first_page_html)
    print(f"Total pages: {total_pages}")

    # Parse first page
    all_items = parse_items_html(first_page_html, categories_map)
    print(f"Page 1: {len(all_items)} items")

    # Fetch remaining pages
    for page in range(2, total_pages + 1):
        html = fetch_items_page(session, auction_id, page, page_size_token)
        items = parse_items_html(html, categories_map)
        print(f"Page {page}: {len(items)} items")
        all_items.extend(items)

    print(f"\nTotal items scraped: {len(all_items)}")

    # Category breakdown
    cat_counts = {}
    for item in all_items:
        cat = item["category"]
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    print("\nCategory breakdown:")
    for cat, count in sorted(cat_counts.items(), key=lambda x: -x[1]):
        print(f"  {cat}: {count}")

    # Skip write if nothing has changed since the last scrape
    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    existing_bids = load_existing_bids(items_path)
    if not has_bid_changes(all_items, existing_bids):
        print(f"\nNo bid changes detected; skipping write for {safe_id}")
        import os
        if os.environ.get("GOONERS_EMBEDDINGS") == "1":
            emb_path = items_path.with_suffix(".embeddings")
            if not emb_path.exists():
                print(f"Embeddings missing for {safe_id}; generating now")
                from embed import generate_and_write as _gen_embeddings
                _gen_embeddings(all_items, items_path, session)
        return {"changed": False}

    # Count distinct bidders per lot (incremental: only fetch changed/new lots)
    existing_unique = load_existing_unique_bidders(items_path)
    enrich_unique_bidders(session, all_items, existing_bids, existing_unique)

    # Write items with embedded auction metadata
    import pyarrow as pa
    import pyarrow.parquet as pq

    ITEMS_DIR.mkdir(parents=True, exist_ok=True)

    end_dates = [item["endDate"] for item in all_items if item["endDate"]]
    # Closed/backfilled auctions have no per-lot end date; fall back to the
    # date in the auction title so they still sort and archive correctly.
    latest_end = max(end_dates) if end_dates else auction_date_from_title(auction_title)
    scraped_at = datetime.now(timezone.utc).isoformat()

    for item in all_items:
        item["auctionId"] = auction_id
        item["auctionSafeId"] = safe_id
        item["auctionTitle"] = auction_title
        item["auctionEndDate"] = latest_end
        # Closed lots carry no live countdown, so their per-lot endDate is
        # blank. Fall back to the auction end date so the UI's countdown shows
        # "Ended" instead of an empty time line.
        if not item["endDate"]:
            item["endDate"] = latest_end
        item["scrapedAt"] = scraped_at
        item["source"] = "cannons"

    # LLM metadata enrichment (#99/#104): brand/model/condition for sharper eBay
    # comp queries + UI display. No-op unless GOONERS_ENRICHMENT=1 + a key is set,
    # so default behavior is unchanged. Runs while images are still arrays.
    # Hand it the prior sidecar so unchanged lots reuse their enrichment instead
    # of re-paying for an identical API call (incremental enrichment).
    from enrich import enrich_items, load_prior_enrichment
    prior_by_id = load_prior_enrichment(ITEMS_DIR / f"{safe_id}.ndjson")
    enrich_items(all_items, prior_by_id=prior_by_id)
    # Mirror enriched lots into Supabase so they're queryable via the API (#104).
    # No-op without SUPABASE_SECRET_KEY or enriched lots.
    from supabase_enrichment import maybe_export_enrichment
    maybe_export_enrichment(all_items)

    # Write NDJSON (images as real array)
    ndjson_path = ITEMS_DIR / f"{safe_id}.ndjson"
    ndjson_lines = [json.dumps(item, separators=(',', ':')) for item in all_items]
    ndjson_path.write_text('\n'.join(ndjson_lines) + '\n', encoding='utf-8')
    print(f"Wrote {len(all_items)} items to {ndjson_path}")

    import os
    if os.environ.get("SUPABASE_SECRET_KEY"):
        from supabase_lots import upsert_lots
        upsert_lots(all_items, safe_id)

    # Generate CLIP embeddings (images still arrays at this point)
    if os.environ.get("GOONERS_EMBEDDINGS") == "1":
        from embed import generate_and_write as _gen_embeddings
        _gen_embeddings(all_items, items_path, session)

    # Generate Nomic Embed (text+vision, 768-dim) → Supabase pgvector table (#165)
    from embed_nomic import maybe_generate_and_upsert as _gen_nomic
    _gen_nomic(all_items, safe_id, session)

    # Write Parquet (images stringified — Arrow doesn't support list-of-strings natively here)
    for item in all_items:
        item["images"] = json.dumps(item["images"])
    table = pa.Table.from_pylist(all_items)
    pq.write_table(table, items_path, compression="snappy")
    print(f"Wrote {len(all_items)} items to {items_path}")

    if snapshot_to_motherduck is None:
        from motherduck import should_snapshot_to_motherduck
        snapshot_to_motherduck = should_snapshot_to_motherduck()

    if snapshot_to_motherduck:
        from warehouse import get_sink
        sink = get_sink()
        if sink is not None:
            snapshot_count = sink.append_listing_snapshots(all_items, auction_url)
            print(f"Appended {snapshot_count} listing snapshots to the warehouse")

    return {"changed": True}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape one Cannon's auction")
    parser.add_argument("auction_url", help="Full Cannon's auction URL")
    parser.add_argument(
        "--motherduck",
        action="store_true",
        help="Append listing snapshots to MotherDuck after the Parquet file is written",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args(sys.argv[1:])
    scrape_auction(args.auction_url, snapshot_to_motherduck=args.motherduck or None)
