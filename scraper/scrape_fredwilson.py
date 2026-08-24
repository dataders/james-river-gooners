#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "pyarrow",
#     "pyyaml",
# ]
# ///
"""
Fred Wilson Auction Service LLC scraper.

Fred Wilson (fredwilsonauction.com) runs on the BWPaperclip auction platform.
Lot data is available via a public JSON REST API at bid.fredwilsonauction.com —
no authentication, session cookies, or HTML parsing required.

Discovery reads /api/auctions and keeps auctions with status="accepting_bids".
Lots are fetched from /api/auctions/{id}/items (paginated, 100/page).

Usage:
    uv run scrape_fredwilson.py <auction_id>          # e.g. 157071
    uv run scrape_fredwilson.py --discover-only       # list active auctions
"""

import argparse
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

import requests
import yaml
from categories import normalize_category, normalize_raw_with_description
from filters import is_real_estate_auction
from http_client import make_session
from persist import WriteContext, write_read_model
from scraper_common import has_bid_changes, load_existing_bids

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"
SOURCES_FILE = Path(__file__).resolve().parent / "fredwilson_sources.yml"

API_BASE = "https://bid.fredwilsonauction.com/api"
UI_BASE = "https://bid.fredwilsonauction.com/ui"
PAGE_SIZE = 100

# Parse "LOCATED IN CITY, VA" / "in Hampton, VA" from tag_line or description.
# Requires a leading preposition so we don't match company names like "Fred Wilson, VA".
_CITY_IN_TEXT_RE = re.compile(
    r"(?:located\s+in|in|at)\s+([A-Za-z][A-Za-z ]{1,30}),\s*([A-Z]{2})\b",
    re.IGNORECASE,
)
# Some Fred Wilson tag lines omit the state (for example, "Located in Newport
# News"). The company only operates in Virginia, so this narrow tag-line-only
# fallback can safely supply VA without making description parsing permissive.
_CITY_ONLY_TAG_LINE_RE = re.compile(
    r"^\s*located\s+in\s+([A-Za-z][A-Za-z ]{1,30})\s*$",
    re.IGNORECASE,
)

# Skip "How to bid", "Payment instructions", etc. info-only lots
_INFO_LOT_RE = re.compile(
    r"^\s*(?:how\s+to\s+(?:bid|register)|bidding\s+instructions?|"
    r"payment\s+instructions?|pickup(?:\s+and)?\s+(?:removal\s+)?instructions?|"
    r"terms\s+(?:of|and)\s+(?:sale|auction))\b",
    re.IGNORECASE,
)

_HTML_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    if not text:
        return ""
    text = _HTML_TAG_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def fredwilson_safe_id(auction_id: str | int) -> str:
    return f"fredwilson_{auction_id}"


def load_sources(sources_file: Path | None = None) -> dict:
    with open(sources_file or SOURCES_FILE) as f:
        return yaml.safe_load(f)


def create_session() -> requests.Session:
    return make_session()


# ---------------------------------------------------------------------------
# Location extraction
# ---------------------------------------------------------------------------


def _city_from_auction(auction: dict) -> tuple[str, str]:
    """Extract (city, state) from a BWPaperclip auction object.

    The list endpoint often returns location=null for active auctions; the city
    is then in tag_line as "LOCATED IN CITY, ST".
    """
    loc = auction.get("location") or {}
    city = (loc.get("city") or "").strip()
    state = (loc.get("state") or "").strip()
    if city and state:
        return city, state

    for field in ("tag_line", "description", "simple_description"):
        text = (auction.get(field) or "").strip()
        if not text:
            continue
        m = _CITY_IN_TEXT_RE.search(text)
        if m:
            return m.group(1).strip().title(), m.group(2).upper()
        if field == "tag_line":
            m = _CITY_ONLY_TAG_LINE_RE.match(text)
            if m:
                return m.group(1).strip().title(), "VA"

    return "", "VA"


# ---------------------------------------------------------------------------
# API fetchers
# ---------------------------------------------------------------------------


def fetch_all_auctions(session: requests.Session) -> list[dict]:
    """Return all Fred Wilson auctions (paginated /api/auctions)."""
    results: list[dict] = []
    page = 1
    while True:
        resp = session.get(
            f"{API_BASE}/auctions",
            params={"page": page, "per_page": PAGE_SIZE},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        batch: list[dict] = data.get("auctions") or []
        total: int = data.get("total", 0)
        if not batch:
            break
        results.extend(batch)
        if len(results) >= total:
            break
        page += 1
    return results


def fetch_auction_detail(session: requests.Session, auction_id: str | int) -> dict:
    """Return the full auction metadata object from /api/auctions/{id}."""
    resp = session.get(f"{API_BASE}/auctions/{auction_id}", timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_auction_items(session: requests.Session, auction_id: str | int) -> list[dict]:
    """Return all lots for one auction (paginated /api/auctions/{id}/items)."""
    items: list[dict] = []
    page = 1
    while True:
        resp = session.get(
            f"{API_BASE}/auctions/{auction_id}/items",
            params={"page": page, "per_page": PAGE_SIZE},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        batch: list[dict] = data.get("items") or []
        total: int = data.get("total", 0)
        if not batch:
            break
        items.extend(batch)
        if len(items) >= total:
            break
        page += 1
    return items


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def discover_fredwilson_specs(sources_file: Path | None = None) -> list[dict]:
    """Return specs for Fred Wilson auctions currently accepting bids."""
    config = load_sources(sources_file)
    company = config["company"]
    slug = company["slug"]
    name = company["name"]

    session = create_session()
    print(f"  Fetching {name} auctions...")
    all_auctions = fetch_all_auctions(session)
    active = [
        a
        for a in all_auctions
        if a.get("active") and a.get("status") == "accepting_bids"
    ]
    print(f"  {len(active)} active of {len(all_auctions)} total")

    specs: list[dict] = []
    for auction in active:
        title = (auction.get("name") or "").strip()
        if is_real_estate_auction(title):
            print(f"    Skipping real estate: {title[:60]}")
            continue
        city, state = _city_from_auction(auction)
        auction_id = str(auction["id"])
        end_date = (auction.get("scheduled_end_time") or "").strip()
        print(f"    Found: [{city or '?'}, {state}] {title[:60]}")
        specs.append(
            {
                "auction_id": auction_id,
                "safe_id": fredwilson_safe_id(auction_id),
                "source_slug": slug,
                "company_name": name,
                "title": title,
                "city": city,
                "state": state,
                "end_date": end_date,
            }
        )
    return specs


# ---------------------------------------------------------------------------
# Item mapping
# ---------------------------------------------------------------------------


def map_item(item_data: dict, auction_id: str) -> dict | None:
    """Map a BWPaperclip lot object to the shared item schema."""
    item_id = item_data.get("id")
    if not item_id:
        return None

    title = (item_data.get("name") or "").strip()
    if not title or _INFO_LOT_RE.match(title):
        return None

    lot_str = (item_data.get("lot_identifier") or "").strip()
    try:
        lot_number = int(lot_str)
    except (TypeError, ValueError):
        lot_number = 0

    description = _strip_html(item_data.get("description") or "")[:500]

    bid_state = item_data.get("api_bidding_state") or {}
    high = bid_state.get("high") or {}
    try:
        current_bid = float(high.get("amount") or 0)
    except (TypeError, ValueError):
        current_bid = 0.0

    try:
        total_bids = int(bid_state.get("accepted_bid_count") or 0)
    except (TypeError, ValueError):
        total_bids = 0

    images: list[str] = []
    for img in item_data.get("images") or []:
        url = img.get("lg") or img.get("xl") or img.get("sm") or img.get("xs") or ""
        if url:
            images.append(url)
    images = images[:5]

    end_date = (item_data.get("scheduled_end_time") or "").strip()

    raw_cat = ""
    combined = f"{title} {description}"

    return {
        "id": f"fredwilson_{item_id}",
        "lotNumber": lot_number,
        "title": title,
        "description": description,
        "currentBid": current_bid,
        "totalBids": total_bids,
        "endDate": end_date,
        "images": images,
        "category": normalize_category(raw_cat, combined, source="fredwilson"),
        "rawCategory": normalize_raw_with_description(
            raw_cat, combined, source="fredwilson"
        ),
        "detailUrl": f"{UI_BASE}/auctions/{auction_id}?lot={lot_str or item_id}",
    }


# ---------------------------------------------------------------------------
# Main scrape function
# ---------------------------------------------------------------------------


def scrape_fredwilson_auction(
    auction_id: str,
    source_slug: str = "fredwilson",
    company_name: str = "Fred Wilson Auction Service LLC",
    auction_title: str = "",
    auction_city: str = "",
    auction_state: str = "VA",
    auction_end_date: str = "",
    snapshot_to_motherduck: bool | None = None,
) -> dict:
    """Scrape one Fred Wilson auction and write the read model. Returns {changed, count}."""
    safe_id = fredwilson_safe_id(auction_id)
    print(f"Scraping Fred Wilson auction {auction_id} ({company_name})")

    session = create_session()
    scraped_at = datetime.now(UTC)

    # Fetch auction metadata when the caller didn't supply it
    if not auction_title or not auction_city:
        detail = fetch_auction_detail(session, auction_id)
        if not auction_title:
            auction_title = (
                detail.get("name") or ""
            ).strip() or f"Fred Wilson Auction {auction_id}"
        if not auction_city:
            auction_city, auction_state = _city_from_auction(detail)
        if not auction_end_date:
            auction_end_date = (detail.get("scheduled_end_time") or "").strip()

    print(f"  Title: {auction_title}")
    print(f"  Location: {auction_city or '(unknown)'}, {auction_state}")

    if is_real_estate_auction(auction_title):
        print("  Skipping: real estate auction")
        return {"changed": False, "skipped": True}

    print("  Fetching lots...")
    raw_items = fetch_auction_items(session, auction_id)
    all_items = [it for it in (map_item(d, auction_id) for d in raw_items) if it]
    filtered = len(raw_items) - len(all_items)
    print(f"  {len(all_items)} lots parsed ({filtered} info/empty lots filtered)")

    if not all_items:
        print("  No items; skipping")
        return {"changed": False}

    if not auction_end_date:
        auction_end_date = max(
            (item["endDate"] for item in all_items if item.get("endDate")),
            default="",
        )

    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    existing_bids = load_existing_bids(items_path)
    if not has_bid_changes(all_items, existing_bids):
        print(f"  No bid changes; skipping write for {safe_id}")
        return {"changed": False}

    ctx = WriteContext(
        safe_id=safe_id,
        auction_id=auction_id,
        auction_title=auction_title,
        auction_end_date=auction_end_date,
        source=source_slug,
        source_url=f"{UI_BASE}/auctions/{auction_id}",
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
    parser = argparse.ArgumentParser(description="Scrape a Fred Wilson auction")
    parser.add_argument(
        "auction_id",
        nargs="?",
        help="BWPaperclip auction ID (from the /ui/auctions/<id>/ URL)",
    )
    parser.add_argument("--source", default="fredwilson", help="Source slug")
    parser.add_argument(
        "--company",
        default="Fred Wilson Auction Service LLC",
        help="Company display name",
    )
    parser.add_argument("--title", default="", help="Auction title (skips API fetch)")
    parser.add_argument("--city", default="", help="Auction city (skips API fetch)")
    parser.add_argument("--state", default="VA", help="State abbreviation")
    parser.add_argument("--end-date", default="", dest="end_date")
    parser.add_argument(
        "--discover-only",
        action="store_true",
        help="Print active auctions and exit",
    )
    parser.add_argument("--motherduck", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args(sys.argv[1:])

    if args.discover_only:
        print("Discovering Fred Wilson auctions...")
        specs = discover_fredwilson_specs()
        print(f"\nFound {len(specs)} active auction(s):")
        for spec in specs:
            print(f"  [{spec['source_slug']}] {spec['title'][:60]}")
            print(f"    {UI_BASE}/auctions/{spec['auction_id']}/")
        sys.exit(0)

    if not args.auction_id:
        print("Error: auction_id is required unless --discover-only", file=sys.stderr)
        sys.exit(1)

    scrape_fredwilson_auction(
        args.auction_id,
        source_slug=args.source,
        company_name=args.company,
        auction_title=args.title,
        auction_city=args.city,
        auction_state=args.state,
        auction_end_date=args.end_date,
        snapshot_to_motherduck=args.motherduck or None,
    )
