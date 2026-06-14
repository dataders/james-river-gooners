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
Rasmus Auctions scraper for Richmond-area auctions.

Rasmus (rasmus.com) runs on the auction-engine.com platform, a multi-tenant app
backed by a public Firebase Firestore project ("dark-shade"). Lot data lives in
the top-level ``items`` collection, tagged with ``origin_sid`` per tenant
("rasmus_auctions_appspot_com"); the auction title/city is only rendered into
each auction page's prerendered SEO meta tags.

This scraper therefore:
  1. Reads active lots straight from the Firestore REST API (filter on
     ``origin_sid`` + future ``time_end``) to discover current auction ids.
  2. Reads each candidate auction's ``<title>``/``og:title`` to get its city and
     keep only Richmond-area, non-real-estate auctions.
  3. Pulls every lot for a kept auction (filter on ``aid``) and writes a Parquet
     file in the same schema as scrape.py / scrape_hibid.py.

Usage:
    python scrape_rasmus.py <aid> [--title "..."] [--source rasmus]
    python scrape_rasmus.py --discover-only   # print what would be scraped
"""

import argparse
import html
import re
import sys
from datetime import datetime, timezone
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
SOURCES_FILE = Path(__file__).resolve().parent / "rasmus_sources.yml"

RASMUS_BASE = "https://rasmus.com"

# Public Firebase web config extracted from rasmus.com's bundle. The API key is a
# browser-safe Firebase web key (it identifies the project, it is not a secret),
# and the `items`/`auctions` collections are world-readable per the project's
# security rules — the same data the public site fetches client-side.
FIRESTORE_PROJECT = "dark-shade"
FIRESTORE_API_KEY = "AIzaSyDU5Q5Qy9xV7FL5oUB3E0d_C4OWoPZaYYU"
FIRESTORE_BASE = (
    f"https://firestore.googleapis.com/v1/projects/{FIRESTORE_PROJECT}"
    "/databases/(default)/documents"
)

PAGE_SIZE = 300


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def rasmus_safe_id(aid: str) -> str:
    return f"rasmus_{aid}"


def create_session() -> requests.Session:
    return make_session()


def _fs_value(v: dict):
    """Decode a single Firestore REST ``Value`` into a Python value."""
    if "stringValue" in v:
        return v["stringValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "booleanValue" in v:
        return bool(v["booleanValue"])
    if "timestampValue" in v:
        return v["timestampValue"]
    if "nullValue" in v:
        return None
    if "arrayValue" in v:
        return [_fs_value(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: _fs_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    return None


def _fs_fields(doc: dict) -> dict:
    return {k: _fs_value(v) for k, v in doc.get("fields", {}).items()}


def ms_to_iso(ms) -> str:
    """Convert an epoch-milliseconds value to an ISO-8601 UTC string."""
    try:
        ms = int(ms)
    except (TypeError, ValueError):
        return ""
    if ms <= 0:
        return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def location_matches(text: str, keywords: list[str]) -> bool:
    """True when any keyword appears as a whole word (case-insensitive) in text."""
    if not text:
        return False
    lower = text.lower()
    for kw in keywords:
        if re.search(r"\b" + re.escape(kw.lower()) + r"\b", lower):
            return True
    return False


def parse_rasmus_category(category) -> str:
    """Pull a human category from Rasmus's ``["0--Category--China"]`` shape."""
    if not category:
        return ""
    first = category[0] if isinstance(category, list) else category
    if not isinstance(first, str):
        return ""
    if "--Category--" in first:
        first = first.split("--Category--", 1)[1]
    # The remaining value may itself be a "Parent--Child" path; take the leaf.
    leaf = [p for p in first.split("--") if p.strip()]
    return leaf[-1].strip() if leaf else ""


# ---------------------------------------------------------------------------
# Firestore REST queries
# ---------------------------------------------------------------------------

def _run_query(session: requests.Session, body: dict) -> list[dict]:
    """POST a structuredQuery and return the list of decoded documents."""
    url = f"{FIRESTORE_BASE}:runQuery?key={FIRESTORE_API_KEY}"
    resp = session.post(url, json=body, timeout=40)
    resp.raise_for_status()
    data = resp.json()
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError(f"Firestore error: {data['error'].get('message')}")
    return [r["document"] for r in data if r.get("document")]


def _eq_filter(field: str, value: str) -> dict:
    return {"fieldFilter": {"field": {"fieldPath": field}, "op": "EQUAL",
                            "value": {"stringValue": value}}}


def fetch_active_auction_ids(
    session: requests.Session, sid: str, now_ms: int | None = None
) -> dict[str, int]:
    """Return {aid: max_time_end_ms} for the site's auctions still open now.

    Paginates the ``items`` collection (projected to aid + time_end) filtered to
    the tenant and to lots whose close time is in the future.
    """
    if now_ms is None:
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    aids: dict[str, int] = {}
    offset = 0
    while True:
        body = {
            "structuredQuery": {
                "from": [{"collectionId": "items"}],
                "where": {"compositeFilter": {"op": "AND", "filters": [
                    _eq_filter("origin_sid", sid),
                    {"fieldFilter": {"field": {"fieldPath": "time_end"},
                                     "op": "GREATER_THAN",
                                     "value": {"integerValue": str(now_ms)}}},
                ]}},
                "select": {"fields": [{"fieldPath": "aid"},
                                      {"fieldPath": "time_end"}]},
                "orderBy": [{"field": {"fieldPath": "time_end"},
                             "direction": "ASCENDING"}],
                "offset": offset,
                "limit": PAGE_SIZE,
            }
        }
        docs = _run_query(session, body)
        for doc in docs:
            f = _fs_fields(doc)
            aid = f.get("aid")
            if not aid:
                continue
            end = int(f.get("time_end") or 0)
            if end > aids.get(aid, 0):
                aids[aid] = end
        if len(docs) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return aids


def fetch_past_auction_ids(
    session: requests.Session,
    sid: str,
    since_ms: int,
    until_ms: int | None = None,
) -> dict[str, int]:
    """Return {aid: max_time_end_ms} for the tenant's auctions that closed in a window.

    Mirrors :func:`fetch_active_auction_ids` but bounds ``time_end`` to
    ``[since_ms, until_ms)`` (a past window). Ordering stays ASCENDING on
    ``time_end`` so it reuses the same Firestore index the active query relies on
    (a DESCENDING order would need a separate index and 400s).
    """
    if until_ms is None:
        until_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    aids: dict[str, int] = {}
    offset = 0
    while True:
        body = {
            "structuredQuery": {
                "from": [{"collectionId": "items"}],
                "where": {"compositeFilter": {"op": "AND", "filters": [
                    _eq_filter("origin_sid", sid),
                    {"fieldFilter": {"field": {"fieldPath": "time_end"},
                                     "op": "GREATER_THAN",
                                     "value": {"integerValue": str(since_ms)}}},
                    {"fieldFilter": {"field": {"fieldPath": "time_end"},
                                     "op": "LESS_THAN",
                                     "value": {"integerValue": str(until_ms)}}},
                ]}},
                "select": {"fields": [{"fieldPath": "aid"},
                                      {"fieldPath": "time_end"}]},
                "orderBy": [{"field": {"fieldPath": "time_end"},
                             "direction": "ASCENDING"}],
                "offset": offset,
                "limit": PAGE_SIZE,
            }
        }
        docs = _run_query(session, body)
        for doc in docs:
            f = _fs_fields(doc)
            aid = f.get("aid")
            if not aid:
                continue
            end = int(f.get("time_end") or 0)
            if end > aids.get(aid, 0):
                aids[aid] = end
        if len(docs) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return aids


def fetch_auction_items(session: requests.Session, aid: str) -> list[dict]:
    """Return every decoded lot document for an auction id (paginated)."""
    items: list[dict] = []
    cursor: str | None = None
    while True:
        query: dict = {
            "from": [{"collectionId": "items"}],
            "where": _eq_filter("aid", aid),
            "orderBy": [{"field": {"fieldPath": "__name__"},
                         "direction": "ASCENDING"}],
            "limit": PAGE_SIZE,
        }
        if cursor is not None:
            query["startAt"] = {
                "before": False,
                "values": [{"referenceValue": cursor}],
            }
        docs = _run_query(session, {"structuredQuery": query})
        if not docs:
            break
        items.extend(docs)
        cursor = docs[-1]["name"]
        if len(docs) < PAGE_SIZE:
            break
    return items


# ---------------------------------------------------------------------------
# Auction-page metadata (title + city for Richmond filtering)
# ---------------------------------------------------------------------------

def _meta_content(htmltext: str, key: str, attr: str = "property") -> str:
    m = re.search(
        rf'<meta\s+{attr}="{re.escape(key)}"\s+content="([^"]*)"',
        htmltext, re.IGNORECASE,
    )
    return html.unescape(m.group(1).strip()) if m else ""


def fetch_auction_meta(session: requests.Session, aid: str) -> dict:
    """Return {title, description, image} from an auction page's SEO meta tags."""
    url = f"{RASMUS_BASE}/auctions/{aid}/a/x"
    try:
        resp = session.get(url, timeout=30)
        resp.raise_for_status()
        text = resp.text
    except Exception as exc:
        print(f"  Warning: could not fetch auction page {aid}: {exc}")
        return {"title": "", "description": "", "image": ""}

    title = _meta_content(text, "og:title")
    if not title:
        m = re.search(r"<title>([^<]*)</title>", text, re.IGNORECASE)
        if m:
            title = html.unescape(m.group(1).strip())
    description = _meta_content(text, "description", attr="name")
    image = _meta_content(text, "og:image")
    return {"title": title, "description": description, "image": image}


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

def load_sources(sources_file: Path | None = None) -> dict:
    with open(sources_file or SOURCES_FILE) as f:
        return yaml.safe_load(f)


def _richmond_specs_from_aids(
    session: requests.Session,
    aids,
    slug: str,
    name: str,
    keywords: list[str],
) -> list[dict]:
    """Filter candidate auction ids down to Richmond-area, non-real-estate specs."""
    specs: list[dict] = []
    for aid in aids:
        meta = fetch_auction_meta(session, aid)
        title = meta["title"]
        haystack = f"{title} {meta['description']}"
        if not location_matches(haystack, keywords):
            print(f"    Skipping (not Richmond): {title[:60]}")
            continue
        if is_real_estate_auction(title):
            print(f"    Skipping real estate: {title[:60]}")
            continue
        print(f"    Found: {title[:60]}")
        specs.append({
            "aid": aid,
            "safe_id": rasmus_safe_id(aid),
            "source_slug": slug,
            "company_name": name,
            "title": title,
            "image": meta["image"],
        })
    return specs


def discover_rasmus_specs(sources_file: Path | None = None) -> list[dict]:
    """Return {aid, title, source_slug, company_name, image} for Richmond auctions."""
    config = load_sources(sources_file)
    site = config["site"]
    sid = site["sid"]
    slug = site["slug"]
    name = site["name"]
    keywords = config.get("location_keywords", [])

    session = create_session()
    print(f"  Finding active {name} auctions (sid={sid})...")
    active = fetch_active_auction_ids(session, sid)
    print(f"  {len(active)} active auction(s); checking which are Richmond-area")
    return _richmond_specs_from_aids(session, active, slug, name, keywords)


def discover_rasmus_past_specs(
    days: int = 90, sources_file: Path | None = None
) -> list[dict]:
    """Return Richmond-area auctions that *closed* within the last ``days``.

    Rasmus sells nationwide, so this scans every tenant auction whose
    ``time_end`` falls in the past window and keeps only Richmond-area,
    non-real-estate ones — the historical sold-price corpus for Cannon's comps.
    """
    config = load_sources(sources_file)
    site = config["site"]
    sid = site["sid"]
    slug = site["slug"]
    name = site["name"]
    keywords = config.get("location_keywords", [])

    session = create_session()
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    since_ms = now_ms - days * 24 * 60 * 60 * 1000
    print(f"  Finding {name} auctions closed in the last {days} days (sid={sid})...")
    past = fetch_past_auction_ids(session, sid, since_ms, now_ms)
    print(f"  {len(past)} closed auction(s); checking which are Richmond-area")
    return _richmond_specs_from_aids(session, past, slug, name, keywords)


# ---------------------------------------------------------------------------
# Item mapping
# ---------------------------------------------------------------------------

def map_item(doc: dict, aid: str) -> dict | None:
    """Map a Firestore lot document into the shared item schema."""
    f = _fs_fields(doc)
    iid = f.get("iid") or doc["name"].split("/")[-1]

    lot = f.get("lot")
    try:
        lot_number = int(lot) if isinstance(lot, (str, int, float)) else 0
    except (TypeError, ValueError):
        lot_number = 0

    title = (f.get("name") or "").strip()
    description = (f.get("description") or "").strip()[:500]

    try:
        current_bid = float(f.get("price") or 0)
    except (TypeError, ValueError):
        current_bid = 0.0

    # Rasmus exposes the distinct bidders per lot (bidders_by_uid) but not a raw
    # bid count. uniqueBidders is therefore exact; totalBids has no truer source
    # than the distinct-bidder count (each placed at least one bid), so we use it
    # as a lower-bound stand-in to keep the shared schema populated.
    bidders = f.get("bidders_by_uid") or []
    unique_bidders = len(bidders) if isinstance(bidders, list) else 0
    has_bids = bool(f.get("has_bids"))
    total_bids = unique_bidders if has_bids else 0
    if has_bids and unique_bidders == 0:
        total_bids = 1  # bid recorded but bidder list withheld

    images: list[str] = []
    for photo in (f.get("photos_display") or []):
        if isinstance(photo, dict) and photo.get("src"):
            images.append(photo["src"])
    images = images[:5]

    raw_cat = parse_rasmus_category(f.get("category"))
    combined = f"{raw_cat} {title} {description}".strip()

    return {
        "id": rasmus_safe_id(iid),
        "lotNumber": lot_number,
        "title": title,
        "description": description,
        "currentBid": current_bid,
        "totalBids": total_bids,
        "uniqueBidders": unique_bidders,
        "endDate": ms_to_iso(f.get("time_end")),
        "images": images,
        "category": normalize_category(raw_cat, combined, source="rasmus"),
        "rawCategory": normalize_raw_with_description(raw_cat, combined, source="rasmus"),
        "detailUrl": f"{RASMUS_BASE}/auctions/{aid}/lot/{lot_number}",
    }




# ---------------------------------------------------------------------------
# Main scrape function
# ---------------------------------------------------------------------------

def scrape_rasmus_auction(
    aid: str,
    source_slug: str = "rasmus",
    company_name: str = "Rasmus Auctions",
    auction_title: str = "",
    snapshot_to_motherduck: bool | None = None,
) -> dict:
    """Scrape one Rasmus auction and write Parquet. Returns {changed, count}."""
    safe_id = rasmus_safe_id(aid)
    print(f"Scraping Rasmus auction {aid} ({company_name})")

    session = create_session()
    scraped_at = datetime.now(timezone.utc)

    if not auction_title:
        auction_title = fetch_auction_meta(session, aid)["title"]
    print(f"  Title: {auction_title or '(unknown)'}")

    if is_real_estate_auction(auction_title):
        print("  Skipping: real estate auction")
        return {"changed": False, "skipped": True}

    print("  Fetching lots...")
    docs = fetch_auction_items(session, aid)
    all_items = [it for it in (map_item(d, aid) for d in docs) if it]
    print(f"  Fetched {len(all_items)} lots")

    if not all_items:
        print("  No items parsed; skipping")
        return {"changed": False}

    auction_end_date = max(
        (item["endDate"] for item in all_items if item.get("endDate")),
        default="",
    )
    if not auction_title:
        auction_title = f"Rasmus Auction {aid}"

    # Skip write if nothing changed
    items_path = ITEMS_DIR / f"{safe_id}.parquet"
    existing_bids = load_existing_bids(items_path)
    if not has_bid_changes(all_items, existing_bids):
        print(f"  No bid changes; skipping write for {safe_id}")
        return {"changed": False}

    ctx = WriteContext(
        safe_id=safe_id,
        auction_id=aid,
        auction_title=auction_title,
        auction_end_date=auction_end_date,
        source=source_slug,
        source_url=f"{RASMUS_BASE}/auctions/{aid}/a/auction",
        scraped_at=scraped_at.isoformat(),
        session=session,
        snapshot_to_motherduck=snapshot_to_motherduck,
    )
    return write_read_model(all_items, ctx)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape a Rasmus auction")
    parser.add_argument("aid", nargs="?", help="Rasmus auction id (from the /auctions/<aid>/ URL)")
    parser.add_argument("--source", default="rasmus", help="Source slug")
    parser.add_argument("--company", default="Rasmus Auctions", help="Display name")
    parser.add_argument("--title", default="", help="Auction title (skips a page fetch)")
    parser.add_argument("--discover-only", action="store_true", help="Print what would be scraped and exit")
    parser.add_argument("--motherduck", action="store_true")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args(sys.argv[1:])

    if args.discover_only:
        print("Discovering Rasmus auctions...")
        specs = discover_rasmus_specs()
        print(f"\nFound {len(specs)} Richmond-area auction(s):")
        for spec in specs:
            print(f"  [{spec['source_slug']}] {spec['title'][:60]}")
            print(f"    {RASMUS_BASE}/auctions/{spec['aid']}/")
        sys.exit(0)

    if not args.aid:
        print("Error: aid is required unless --discover-only is used", file=sys.stderr)
        sys.exit(1)

    scrape_rasmus_auction(
        args.aid,
        source_slug=args.source,
        company_name=args.company,
        auction_title=args.title,
        snapshot_to_motherduck=args.motherduck or None,
    )
