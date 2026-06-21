# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "pyyaml",
#     "pyarrow",
#     "pydantic-settings>=2,<3",
# ]
# ///
"""Facebook Marketplace source via Apify.

Each configured keyword is scraped in two modes:
- active listings -> shared `lots` read model (`source=facebook`)
- sold listings   -> gated `facebook_sold_listings` corpus
"""

from __future__ import annotations

import argparse
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

import env_secrets as secrets
import requests
import yaml
from persist import WriteContext, write_read_model

FACEBOOK_SOURCES = Path(__file__).resolve().parent / "facebook_sources.yml"
APIFY_API_URL = "https://api.apify.com/v2"
APIFY_ACTOR_ID = "apify~facebook-marketplace-scraper"
APIFY_POLL_INTERVAL = 10
APIFY_MAX_WAIT = 900
DEFAULT_LIMIT = 60


def _token() -> str | None:
    return secrets.apify_token()


def facebook_safe_id(keyword: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", keyword.lower()).strip("_")
    return f"facebook_{slug or 'search'}"


def _marketplace_url(location: str, keyword: str, *, exact: bool, sold: bool) -> str:
    params = {}
    if sold:
        params["availability"] = "out%20of%20stock"
    params["query"] = keyword
    if exact:
        params["exact"] = "true"
    query = urlencode(params).replace("out%2520of%2520stock", "out%20of%20stock")
    return f"https://www.facebook.com/marketplace/{location}/search?{query}"


def discover_facebook_specs(path: Path = FACEBOOK_SOURCES) -> list[dict]:
    data = yaml.safe_load(path.read_text()) or {}
    location = str(data.get("location") or "richmond").strip() or "richmond"
    specs: list[dict] = []
    for search in data.get("searches") or []:
        keyword = str(search.get("keyword") or "").strip()
        if not keyword:
            continue
        exact = bool(search.get("exact", True))
        specs.append(
            {
                "keyword": keyword,
                "location": location,
                "exact": exact,
                "safe_id": facebook_safe_id(keyword),
                "active_url": _marketplace_url(
                    location, keyword, exact=exact, sold=False
                ),
                "sold_url": _marketplace_url(location, keyword, exact=exact, sold=True),
            }
        )
    return specs


def _text(value, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _price(card: dict) -> tuple[float | None, str]:
    raw = card.get("listing_price") or card.get("price") or {}
    if not isinstance(raw, dict):
        raw = {"amount": raw}
    label = _text(
        raw.get("formatted_amount")
        or raw.get("formattedAmount")
        or raw.get("display")
        or raw.get("label")
    )
    amount = raw.get("amount") or raw.get("value")
    if amount is None and label:
        amount = re.sub(r"[^0-9.]", "", label)
    if amount is None:
        return None, label
    try:
        value = float(amount)
    except (TypeError, ValueError):
        value = None
    return value, label


def _photo(card: dict) -> str:
    photo = card.get("primary_listing_photo") or card.get("primaryListingPhoto") or {}
    if isinstance(photo, dict):
        image = photo.get("image") or {}
        if isinstance(image, dict):
            return _text(image.get("uri") or image.get("url"))
        return _text(photo.get("uri") or photo.get("url"))
    return ""


def _location(card: dict) -> str:
    loc = card.get("location") or {}
    if not isinstance(loc, dict):
        return _text(loc)
    if loc.get("name"):
        return _text(loc.get("name"))
    rev = loc.get("reverse_geocode") or loc.get("reverseGeocode") or {}
    if isinstance(rev, dict):
        parts = [rev.get("city"), rev.get("state")]
        return ", ".join(_text(p) for p in parts if _text(p))
    return ""


def card_to_item(card: dict) -> dict:
    price, _label = _price(card)
    listing_url = _text(card.get("listingUrl") or card.get("url"))
    listing_id = _text(card.get("id") or card.get("listing_id") or listing_url)
    image = _photo(card)
    item = {
        "id": listing_id,
        "title": _text(card.get("title")),
        "description": _text(card.get("description")),
        "currentBid": price or 0.0,
        "images": [image] if image else [],
        "category": "Facebook Marketplace",
        "rawCategory": "Facebook Marketplace",
        "detailUrl": listing_url,
        "lotNumber": None,
        "endDate": None,
    }
    return item


def card_to_sold_listing_row(card: dict, *, keyword: str) -> dict:
    price, label = _price(card)
    return {
        "id": _text(card.get("id") or card.get("listing_id") or card.get("listingUrl")),
        "keyword": keyword,
        "title": _text(card.get("title")),
        "price_value": price,
        "price_label": label,
        "sold_date": card.get("sold_date") or card.get("soldDate"),
        "thumbnail_url": _photo(card),
        "listing_url": _text(card.get("listingUrl") or card.get("url")),
        "location": _location(card),
    }


def _apify_headers(api_token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }


def _apify_input(urls: list[str], *, limit: int = DEFAULT_LIMIT) -> dict:
    return {
        "startUrls": [{"url": url} for url in urls],
        "resultsLimit": limit,
    }


def start_apify_run(
    api_token: str, urls: list[str], *, limit: int = DEFAULT_LIMIT
) -> tuple[str, str]:
    resp = requests.post(
        f"{APIFY_API_URL}/acts/{APIFY_ACTOR_ID}/runs",
        headers=_apify_headers(api_token),
        json=_apify_input(urls, limit=limit),
        timeout=(10, 30),
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return data["id"], data["defaultDatasetId"]


def wait_for_apify_run(
    api_token: str,
    run_id: str,
    *,
    poll_interval: int = APIFY_POLL_INTERVAL,
    max_wait: int = APIFY_MAX_WAIT,
) -> str:
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        resp = requests.get(
            f"{APIFY_API_URL}/actor-runs/{run_id}",
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=(10, 30),
        )
        resp.raise_for_status()
        status = resp.json()["data"]["status"]
        if status in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            return status
        time.sleep(poll_interval)
    return "TIMED-OUT"


def fetch_apify_dataset(api_token: str, dataset_id: str) -> list[dict]:
    resp = requests.get(
        f"{APIFY_API_URL}/datasets/{dataset_id}/items",
        headers={"Authorization": f"Bearer {api_token}"},
        params={"clean": "true", "format": "json"},
        timeout=(10, 60),
    )
    resp.raise_for_status()
    body = resp.json()
    if isinstance(body, list):
        return body
    return body.get("items") or []


def run_apify_urls(
    api_token: str,
    urls: list[str],
    *,
    limit: int = DEFAULT_LIMIT,
    poll_interval: int = APIFY_POLL_INTERVAL,
    max_wait: int = APIFY_MAX_WAIT,
) -> list[dict]:
    run_id, dataset_id = start_apify_run(api_token, urls, limit=limit)
    status = wait_for_apify_run(
        api_token, run_id, poll_interval=poll_interval, max_wait=max_wait
    )
    if status != "SUCCEEDED":
        raise RuntimeError(f"Apify run {run_id} ended with {status}")
    return fetch_apify_dataset(api_token, dataset_id)


def scrape_spec(
    spec: dict, *, api_token: str | None = None, limit: int = DEFAULT_LIMIT
) -> dict:
    api_token = api_token or _token()
    if not api_token:
        print(
            "WARNING: GOONERS_APIFY_TOKEN/APIFY_API_KEY is not set; skipping Facebook scrape"
        )
        return {"active": 0, "sold": 0}

    active_cards = run_apify_urls(api_token, [spec["active_url"]], limit=limit)
    sold_cards = run_apify_urls(api_token, [spec["sold_url"]], limit=limit)

    items = [card_to_item(card) for card in active_cards]
    items = [item for item in items if item.get("id") and item.get("detailUrl")]
    now = datetime.now(UTC).isoformat()
    if items:
        write_read_model(
            items,
            WriteContext(
                safe_id=spec["safe_id"],
                auction_id=spec["active_url"],
                auction_title=f"Facebook Marketplace: {spec['keyword']}",
                auction_end_date="",
                source="facebook",
                source_url=spec["active_url"],
                scraped_at=now,
            ),
        )
        if secrets.supabase_secret_key():
            from supabase_lots import delete_active_lots_not_in_set

            delete_active_lots_not_in_set(
                spec["safe_id"], {str(item["id"]) for item in items}
            )

    sold_rows = [
        card_to_sold_listing_row(card, keyword=spec["keyword"]) for card in sold_cards
    ]
    if sold_rows:
        from supabase_facebook import maybe_export_facebook_sold_listings

        maybe_export_facebook_sold_listings(sold_rows)

    return {"active": len(items), "sold": len(sold_rows)}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape Facebook Marketplace")
    parser.add_argument("--keyword", help="Only scrape this configured keyword")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    specs = discover_facebook_specs()
    if args.keyword:
        specs = [spec for spec in specs if spec["keyword"] == args.keyword]
    if not specs:
        print("No Facebook Marketplace searches configured")
        return
    for spec in specs:
        print(f"Scraping Facebook Marketplace: {spec['keyword']}")
        summary = scrape_spec(spec, limit=args.limit)
        print(
            f"Facebook {spec['keyword']}: "
            f"{summary['active']} active, {summary['sold']} sold"
        )


if __name__ == "__main__":
    main()
