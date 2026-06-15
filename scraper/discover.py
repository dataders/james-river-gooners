#!/usr/bin/env python3
"""
Discover current Cannon's auction item URLs from Maxanet auction cards.
"""

import html
import re
from urllib.parse import parse_qs, unquote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://bid.cannonsauctions.com"
GET_AUCTIONS_PATH = "/Public/Auction/GetAuctions"


def _auction_key(url: str) -> str:
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    if "AuctionId" in params:
        return unquote(params["AuctionId"][0])
    return url


def extract_auction_item_urls(page_html: str, base_url: str = BASE_URL) -> list[str]:
    """Extract full AuctionItems URLs from a GetAuctions HTML fragment."""
    soup = BeautifulSoup(page_html, "html.parser")
    urls = []
    seen = set()
    pattern = re.compile(r"(/Public/Auction/AuctionItems\?[^\"')]+)")

    def add_url(value: str) -> None:
        if not value:
            return
        decoded = html.unescape(value)
        if "AuctionItems" not in decoded:
            return
        full_url = urljoin(base_url, decoded)
        key = _auction_key(full_url)
        if key in seen:
            return
        seen.add(key)
        urls.append(full_url)

    for link in soup.find_all("a"):
        add_url(link.get("href", ""))
        onclick = link.get("onclick", "")
        for match in pattern.findall(onclick):
            add_url(match)

    return urls


def _discover_auction_urls(
    auction_filter: str,
    page_size: int = 100,
    max_pages: int = 10,
    limit: int | None = None,
) -> list[str]:
    """Fetch auction cards for a GetAuctions ``filter`` and return item URLs.

    ``filter="Current"`` returns live auctions; ``filter="Past"`` returns closed
    auctions (newest first). ``limit`` caps the number of URLs returned.
    """
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "X-Requested-With": "XMLHttpRequest",
        }
    )
    session.get(f"{BASE_URL}/Public", timeout=30).raise_for_status()

    urls = []
    seen = set()
    for page in range(1, max_pages + 1):
        resp = session.get(
            f"{BASE_URL}{GET_AUCTIONS_PATH}",
            params={
                "pageNumber": page,
                "filter": auction_filter,
                "auctionTypeFilter": "",
                "pageSize": page_size,
                "viewType": "Grid",
            },
            timeout=30,
        )
        resp.raise_for_status()
        page_urls = extract_auction_item_urls(resp.text)
        if not page_urls:
            break
        for url in page_urls:
            key = _auction_key(url)
            if key not in seen:
                seen.add(key)
                urls.append(url)
                if limit is not None and len(urls) >= limit:
                    return urls
        if len(page_urls) < page_size:
            break

    return urls


def discover_current_auction_urls(
    page_size: int = 100, max_pages: int = 10
) -> list[str]:
    """Fetch current auction cards and return full AuctionItems URLs."""
    return _discover_auction_urls("Current", page_size=page_size, max_pages=max_pages)


def discover_past_auction_urls(
    limit: int | None = None, page_size: int = 100, max_pages: int = 10
) -> list[str]:
    """Fetch closed (past) auction cards, newest first, and return item URLs."""
    return _discover_auction_urls(
        "Past", page_size=page_size, max_pages=max_pages, limit=limit
    )
