#!/usr/bin/env python3
"""
Cannon's Auctions scraper.

Fetches auction item data from the Maxanet platform and outputs clean JSON.
Usage: python scrape.py <auction_url>
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse, unquote

import requests
from bs4 import BeautifulSoup

from categories import normalize_category, normalize_raw_with_description


DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"


def sanitize_auction_id(auction_id: str) -> str:
    """Convert base64 auction ID to filesystem-safe string."""
    return auction_id.replace("+", "-").replace("/", "_").replace("=", "")


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
    resp = session.get(auction_url, allow_redirects=True)
    resp.raise_for_status()
    return session, resp.text


def fetch_categories(session: requests.Session, auction_id: str) -> dict:
    """Fetch category list from Maxanet API. Returns {id: name} dict."""
    url = f"https://bid.cannonsauctions.com/Public/Lookup/GetCategories"
    resp = session.get(url, params={"AuctionId": auction_id})
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
    category = normalize_category(raw_category)

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
        "endDate": end_date,
        "images": images[:5],  # Keep first 5 images
        "category": normalize_category(raw_category, description),
        "rawCategory": normalize_raw_with_description(raw_category, description),
        "detailUrl": detail_url,
    }


def scrape_auction(auction_url: str) -> None:
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

    # Write items as Parquet with embedded auction metadata
    import pyarrow as pa
    import pyarrow.parquet as pq

    ITEMS_DIR.mkdir(parents=True, exist_ok=True)

    end_dates = [item["endDate"] for item in all_items if item["endDate"]]
    latest_end = max(end_dates) if end_dates else ""
    scraped_at = datetime.now(timezone.utc).isoformat()

    # Embed auction metadata in each item row
    for item in all_items:
        item["images"] = json.dumps(item["images"])
        item["auctionId"] = auction_id
        item["auctionSafeId"] = safe_id
        item["auctionTitle"] = auction_title
        item["auctionEndDate"] = latest_end
        item["scrapedAt"] = scraped_at

    table = pa.Table.from_pylist(all_items)
    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    pq.write_table(table, items_path, compression="snappy")
    print(f"\nWrote {len(all_items)} items to {items_path}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scrape.py <auction_url>")
        print("Example: python scrape.py 'https://bid.cannonsauctions.com/Public/Auction/AuctionItems?AuctionId=...'")
        sys.exit(1)

    scrape_auction(sys.argv[1])
