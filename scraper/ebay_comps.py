#!/usr/bin/env python
"""
Fetch eBay sold-comps into the static GitHub Pages read model.

The per-auction JSON files under public/data/ebay-comps/ are the source of
truth for comps and are accumulated incrementally: each run refreshes a
rate-limited subset of items and merges the results into the existing files.
MotherDuck (or any warehouse behind scraper/warehouse.py) is an OPTIONAL
mirror, written only when a warehouse is configured - it is never required to
produce the read model. See docs/data-architecture.md.
"""

import argparse
import json
import os
import random
import re
import shlex
import subprocess
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from time import sleep
from urllib.parse import parse_qs, urlencode, urlparse


DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
EBAY_COMPS_DIR = DATA_DIR / "ebay-comps"
EBAY_SEARCH_URL = "https://www.ebay.com/sch/i.html"
PUBLIC_VIEW = "public_auction_comps"
SNAPSHOT_TABLE = "ebay_comp_snapshots"
DEFAULT_LIMIT = 50
DEFAULT_STALE_HOURS = 7 * 24
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
DEFAULT_AGENT_BROWSER_COMMAND = "npm exec --yes agent-browser@0.27.0 --"
SOLDCOMPS_API_URL = "https://api.sold-comps.com/v1/scrape"
BLOCK_BACKOFF_MIN = 30.0
BLOCK_BACKOFF_MAX = 90.0
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0",
]

STOP_WORDS = {
    "and",
    "as",
    "barrel",
    "cal",
    "caliber",
    "condition",
    "for",
    "includes",
    "including",
    "is",
    "lot",
    "measure",
    "measures",
    "missing",
    "model",
    "neither",
    "number",
    "please",
    "preview",
    "remote",
    "remotes",
    "serial",
    "shot",
    "sold",
    "the",
    "this",
    "used",
    "with",
    "working",
}
RESTRICTED_CATEGORIES = {"Firearms"}

EXPORT_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "status",
    "query",
    "search_url",
    "fetched_at",
    "warning",
    "ebay_item_id",
    "title",
    "price_value",
    "price_currency",
    "shipping_label",
    "sold_date",
    "sold_date_label",
    "thumbnail_url",
    "item_web_url",
    "condition",
    "source_query",
    "match_confidence",
)

CREATE_COMP_TABLE_SQL = f"""
create table if not exists {SNAPSHOT_TABLE} (
  auction_safe_id text,
  item_id text,
  status text,
  query text,
  search_url text,
  fetched_at timestamptz,
  warning text,
  ebay_item_id text,
  title text,
  price_value decimal(12, 2),
  price_currency text,
  shipping_label text,
  sold_date date,
  sold_date_label text,
  thumbnail_url text,
  item_web_url text,
  condition text,
  source_query text,
  match_confidence text,
  auction_id text,
  lot_number bigint,
  cannons_title text,
  cannons_description text,
  current_bid decimal(12, 2),
  total_bids integer,
  detail_url text,
  raw_match_json text,
  ingested_at timestamptz default now()
)
"""

PUBLIC_VIEW_SQL = f"""
create or replace view {PUBLIC_VIEW} as
select {", ".join(EXPORT_COLUMNS)}
from (
  select
    {", ".join(EXPORT_COLUMNS)},
    dense_rank() over (
      partition by auction_safe_id, item_id, source_query
      order by fetched_at desc
    ) as fetch_rank
  from {SNAPSHOT_TABLE}
  where item_web_url is not null
)
where fetch_rank = 1
"""

INSERT_COMP_SQL = f"""
insert into {SNAPSHOT_TABLE} (
  auction_safe_id,
  item_id,
  status,
  query,
  search_url,
  fetched_at,
  warning,
  ebay_item_id,
  title,
  price_value,
  price_currency,
  shipping_label,
  sold_date,
  sold_date_label,
  thumbnail_url,
  item_web_url,
  condition,
  source_query,
  match_confidence,
  auction_id,
  lot_number,
  cannons_title,
  cannons_description,
  current_bid,
  total_bids,
  detail_url,
  raw_match_json
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def utc_now_text() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_value(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    return value


def text_value(value, default: str = "") -> str:
    if value is None:
        return default
    return str(json_value(value))


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def random_user_agent(_choice=random.choice) -> str:
    return _choice(USER_AGENTS)


def jitter_sleep(base_seconds: float, _rand=random.uniform) -> None:
    if base_seconds <= 0:
        return
    sleep(_rand(base_seconds * 0.5, base_seconds * 2.5))


def compact_item_text(item: dict) -> str:
    raw_text = " ".join(
        str(part)
        for part in (
            item.get("description"),
            "" if re.match(r"^lot\s*-", str(item.get("title", "")), re.IGNORECASE) else item.get("title"),
            item.get("rawCategory"),
        )
        if part
    )
    cleaned = raw_text
    for pattern in (
        r"\bserial\s+number\b.*$",
        r"\bthis is a used firearm\b.*$",
        r"\bplease preview\b.*$",
        r"\bmeasures?\b.*$",
    ):
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("“", '"').replace("”", '"')
    cleaned = re.sub(r"[^\w\s\".'-]", " ", cleaned)
    return normalize_spaces(cleaned)


def meaningful_tokens(text: str) -> list[str]:
    tokens = []
    for token in normalize_spaces(text).split(" "):
        cleaned = token.strip("-'\"`")
        if cleaned and cleaned.lower() not in STOP_WORDS:
            tokens.append(cleaned)
    return tokens


def dedupe_words(words: list[str]) -> list[str]:
    seen = set()
    deduped = []
    for word in words:
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(word)
    return deduped


def build_ebay_sold_search_url(query: str) -> str:
    params = urlencode({
        "_nkw": query,
        "LH_Sold": "1",
        "LH_Complete": "1",
        "_sop": "13",
    })
    return f"{EBAY_SEARCH_URL}?{params}"


def build_ebay_sold_searches(item: dict) -> list[dict]:
    text = compact_item_text(item)
    tokens = meaningful_tokens(text)
    model_tokens = [
        token for token in tokens
        if re.search(r"[A-Za-z]\d|\d[A-Za-z]|[-/]\d", token) and len(token) >= 4
    ]
    # Keep queries short — eBay sold-listing searches return nothing for long,
    # over-specific keyword strings. Funnel from a precise query down to broad
    # fallbacks so an item that misses on the specific query can still match.
    broad_tokens = [token for token in tokens if not re.match(r"^\d+$", token)][:3]
    specific_tokens = dedupe_words(tokens[:4] + model_tokens)[:5]
    category_tokens = meaningful_tokens(f"{item.get('rawCategory') or item.get('category') or ''} {text}")[:4]

    candidates = [
        {"kind": "specific", "label": "Specific match", "query": " ".join(specific_tokens)},
        {"kind": "broad", "label": "Broader match", "query": " ".join(broad_tokens)},
        {"kind": "category", "label": "Category match", "query": " ".join(dedupe_words(category_tokens))},
    ]
    warning = (
        "eBay may return limited results for restricted categories."
        if item.get("category") in RESTRICTED_CATEGORIES
        else ""
    )

    searches = []
    seen = set()
    for candidate in candidates:
        query = normalize_spaces(candidate["query"])
        key = query.lower()
        if not query or key in seen:
            continue
        seen.add(key)
        searches.append({
            **candidate,
            "query": query,
            "url": build_ebay_sold_search_url(query),
            "warning": warning,
        })
    return searches


def is_ebay_item_url(value: str) -> bool:
    if not value:
        return False

    try:
        parsed = urlparse(value)
    except ValueError:
        return False

    hostname = parsed.hostname or ""
    if hostname != "ebay.com" and not hostname.endswith(".ebay.com"):
        return False

    segments = [segment for segment in parsed.path.split("/") if segment]
    if "itm" not in segments:
        return False

    item_index = segments.index("itm")
    return any(segment.isdigit() and len(segment) >= 9 for segment in segments[item_index + 1:])


def extract_ebay_item_id(value: str) -> str | None:
    if not value:
        return None

    try:
        parsed = urlparse(value)
    except ValueError:
        return None

    hostname = parsed.hostname or ""
    if hostname != "ebay.com" and not hostname.endswith(".ebay.com"):
        return None

    segments = [segment for segment in parsed.path.split("/") if segment]
    if "itm" in segments:
        item_index = segments.index("itm")
        for segment in segments[item_index + 1:]:
            if segment.isdigit() and len(segment) >= 9:
                return segment

    query_values = parse_qs(parsed.query)
    for key in ("_trksid", "hash"):
        query_values.pop(key, None)
    for values in query_values.values():
        for value_part in values:
            if value_part.isdigit() and len(value_part) >= 9:
                return value_part

    return None


def canonical_ebay_item_url(value: str) -> str | None:
    item_id = extract_ebay_item_id(value)
    if not item_id:
        return None
    return f"https://www.ebay.com/itm/{item_id}"


def first_text(element, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        match = element.select_one(selector)
        if match:
            value = normalize_spaces(match.get_text(" ", strip=True))
            if value:
                return value
    return ""


def first_attr(element, selectors: tuple[str, ...], attr: str) -> str:
    for selector in selectors:
        match = element.select_one(selector)
        if match and match.get(attr):
            return str(match.get(attr))
    return ""


def price_amount(value: str) -> str | None:
    text = normalize_spaces(value)
    match = re.search(r"([0-9][0-9,]*(?:\.[0-9]{2})?)", text)
    if not match:
        return None

    try:
        amount = Decimal(match.group(1).replace(",", ""))
    except InvalidOperation:
        return None
    return f"{amount:.2f}"


def price_currency(value: str) -> str:
    return "USD" if "$" in (value or "") else ""


def sold_label_from_card(card) -> str:
    for text in card.stripped_strings:
        cleaned = normalize_spaces(text)
        if re.match(r"^sold\b", cleaned, re.IGNORECASE):
            return cleaned
    return ""


def sold_date_from_label(label: str) -> str | None:
    cleaned = re.sub(r"^sold\s+", "", normalize_spaces(label), flags=re.IGNORECASE)
    for pattern in ("%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(cleaned, pattern).date().isoformat()
        except ValueError:
            continue
    return None


def date_from_iso(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = str(value).strip()
    if cleaned.endswith("Z"):
        cleaned = f"{cleaned[:-1]}+00:00"
    try:
        return datetime.fromisoformat(cleaned).date().isoformat()
    except ValueError:
        return None


def sold_date_label_from_iso(value: str | None) -> str:
    sold_date = date_from_iso(value)
    if not sold_date:
        return ""
    try:
        parsed = datetime.strptime(sold_date, "%Y-%m-%d").date()
    except ValueError:
        return ""
    return f"Sold {parsed.strftime('%b')} {parsed.day}, {parsed.year}"


def shipping_label(value) -> str:
    if value in (None, ""):
        return ""
    amount = price_amount(str(value))
    if amount is None:
        return text_value(value)
    if Decimal(amount) == 0:
        return "Free shipping"
    return f"+${amount} shipping"


def parse_sold_search_html(html: str, source_query: str, max_matches: int = 3) -> list[dict]:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("li.s-item, div.s-card, li.s-card")
    matches = []
    seen = set()

    for card in cards:
        link = first_attr(card, ("a.s-item__link[href]", "a[href*='/itm/']"), "href")
        item_web_url = canonical_ebay_item_url(link)
        if not item_web_url:
            continue

        ebay_item_id = extract_ebay_item_id(item_web_url)
        if not ebay_item_id or ebay_item_id in seen:
            continue

        title = first_text(card, (".s-item__title", ".s-card__title", "[role='heading']"))
        if not title or title.lower() == "shop on ebay":
            continue

        price_label = first_text(card, (".s-item__price", ".s-card__price", "[data-testid='x-price-primary']"))
        amount = price_amount(price_label)
        if not amount:
            continue

        sold_label = sold_label_from_card(card)
        image_url = first_attr(card, (".s-item__image-img[src]", "img[src]"), "src")
        if image_url.startswith("data:"):
            image_url = ""

        matches.append({
            "ebay_item_id": ebay_item_id,
            "title": title,
            "price_value": amount,
            "price_currency": price_currency(price_label) or "USD",
            "shipping_label": first_text(card, (".s-item__shipping", ".s-card__shipping")),
            "sold_date": sold_date_from_label(sold_label),
            "sold_date_label": sold_label,
            "thumbnail_url": image_url,
            "item_web_url": item_web_url,
            "condition": first_text(card, (".SECONDARY_INFO", ".s-card__subtitle")),
            "source_query": source_query,
            "match_confidence": "medium",
        })
        seen.add(ebay_item_id)

        if len(matches) >= max_matches:
            break

    return matches


# TEMPORARY DIAGNOSTIC: records what eBay actually returned on a no_results/blocked
# fetch so we can tell selector drift from a soft-block. Remove once the parser is fixed.
_DEBUG_MARKERS = (
    "s-item",
    "s-card",
    "srp-results",
    "srp-river-results",
    "brwrvr__item-card",
    "su-card-container",
    "srp-controls",
    "/itm/",
    "captcha",
    "Pardon Our Interruption",
    "Checking your browser",
    "splashui",
    "Enter the characters",
    "Access Denied",
)


def page_debug_signature(html: str, fetched_via: str, http_status=None) -> dict:
    html = html or ""
    import re as _re
    m = _re.search(r"<title[^>]*>([^<]*)</title>", html, _re.IGNORECASE)
    return {
        "fetchedVia": fetched_via,
        "httpStatus": http_status,
        "bytes": len(html),
        "title": (m.group(1).strip()[:160] if m else ""),
        "markers": [marker for marker in _DEBUG_MARKERS if marker in html],
    }

def soldcomps_item_match(item: dict, source_query: str) -> dict | None:
    item_web_url = canonical_ebay_item_url(text_value(item.get("url") or item.get("itemUrl") or item.get("itemWebUrl")))
    if not item_web_url:
        return None

    title = text_value(item.get("title"))
    price_value = price_amount(text_value(item.get("soldPrice") or item.get("price") or item.get("priceValue")))
    if not title or not price_value:
        return None

    ended_at = text_value(item.get("endedAt") or item.get("soldAt") or item.get("soldDate"))
    return {
        "ebay_item_id": text_value(item.get("itemId") or item.get("ebayItemId")) or extract_ebay_item_id(item_web_url),
        "title": title,
        "price_value": price_value,
        "price_currency": text_value(item.get("soldCurrency") or item.get("currency"), "USD"),
        "shipping_label": shipping_label(item.get("shippingPrice") or item.get("shippingCost") or item.get("shipping")),
        "sold_date": date_from_iso(ended_at),
        "sold_date_label": sold_date_label_from_iso(ended_at),
        "thumbnail_url": text_value(item.get("imageUrl") or item.get("thumbnailUrl") or item.get("image")),
        "item_web_url": item_web_url,
        "condition": text_value(item.get("condition")),
        "source_query": source_query,
        "match_confidence": "medium",
    }


def soldcomps_sold_matches(
    session,
    search: dict,
    api_key: str | None = None,
    max_matches: int = 3,
    timeout: int = 30,
) -> dict | None:
    api_key = api_key or os.environ.get("SOLDCOMPS_API_KEY")
    if not api_key:
        return None

    response = session.get(
        os.environ.get("SOLDCOMPS_API_URL", SOLDCOMPS_API_URL),
        params={"keyword": search["query"]},
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "james-river-gooners/1.0",
        },
        timeout=timeout,
    )
    if response.status_code >= 400:
        return {
            "status": "error",
            "warning": f"SoldComps API returned HTTP {response.status_code}.",
            "matches": [],
        }

    payload = response.json()
    raw_items = payload.get("items") or payload.get("results") or []
    matches = []
    seen = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        match = soldcomps_item_match(raw_item, source_query=search["kind"])
        if not match:
            continue
        key = match["item_web_url"]
        if key in seen:
            continue
        seen.add(key)
        matches.append(match)
        if len(matches) >= max_matches:
            break

    return {
        "status": "ok" if matches else "no_results",
        "warning": search.get("warning") or "",
        "matches": matches,
    }


def agent_browser_env() -> dict:
    allowed = {
        "CI",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "RUNNER_TEMP",
        "RUNNER_TOOL_CACHE",
        "SHELL",
        "TMP",
        "TMPDIR",
        "TEMP",
        "USER",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed and value}
    env.setdefault("npm_config_cache", str(Path(os.environ.get("RUNNER_TEMP", "/tmp")) / "npm-agent-browser"))
    env.setdefault("AGENT_BROWSER_ALLOWED_DOMAINS", "www.ebay.com,ebay.com")
    env.setdefault("AGENT_BROWSER_ARGS", "--no-sandbox,--disable-blink-features=AutomationControlled")
    env.setdefault("AGENT_BROWSER_DEFAULT_TIMEOUT", "30000")
    env.setdefault("AGENT_BROWSER_SESSION", "gooners-ebay-comps")
    env.setdefault("AGENT_BROWSER_USER_AGENT", os.environ.get("GOONERS_EBAY_USER_AGENT", DEFAULT_USER_AGENT))
    return env


def run_agent_browser(args: list[str], timeout: int = 45) -> str:
    command = shlex.split(os.environ.get("GOONERS_AGENT_BROWSER_COMMAND", DEFAULT_AGENT_BROWSER_COMMAND))
    result = subprocess.run(
        command + args,
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=agent_browser_env(),
    )
    return result.stdout.strip()


def agent_browser_html(url: str, browser_runner=run_agent_browser) -> str:
    try:
        browser_runner(["open", url], timeout=45)
    except Exception:
        browser_runner(["install"], timeout=180)
        browser_runner(["open", url], timeout=45)
    try:
        browser_runner(["wait", "li.s-item, .s-card"], timeout=30)
    except Exception:
        pass
    try:
        try:
            return html_from_browser_output(browser_runner(["get", "html"], timeout=45))
        except Exception:
            return html_from_browser_output(browser_runner(["eval", "document.documentElement.outerHTML"], timeout=45))
    finally:
        try:
            browser_runner(["close"], timeout=10)
        except Exception:
            pass


def html_from_browser_output(output: str) -> str:
    cleaned = output.strip()
    if not cleaned:
        return ""

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, str):
        return parsed
    if isinstance(parsed, dict):
        for key in ("result", "value", "output", "text", "data"):
            if isinstance(parsed.get(key), str):
                return parsed[key]

    html_start = cleaned.lower().find("<html")
    if html_start < 0:
        html_start = cleaned.lower().find("<!doctype")
    return cleaned[html_start:] if html_start >= 0 else cleaned


def browser_sold_matches(search: dict, max_matches: int = 3, browser_runner=run_agent_browser) -> dict:
    try:
        html = agent_browser_html(search["url"], browser_runner=browser_runner)
    except Exception as exc:
        return {
            "status": "blocked",
            "warning": f"eBay HTTP fetch was blocked and agent-browser fallback failed: {exc}",
            "matches": [],
        }

    if "Access Denied" in html or "Service Unavailable" in html:
        return {
            "status": "blocked",
            "warning": "eBay blocked both HTTP and browser fallback fetches.",
            "matches": [],
            "debug": page_debug_signature(html, fetched_via="browser"),
        }

    matches = parse_sold_search_html(html, source_query=search["kind"], max_matches=max_matches)
    return {
        "status": "ok" if matches else "no_results",
        "warning": search.get("warning") or "",
        "debug": page_debug_signature(html, fetched_via="browser"),
        "matches": matches,
    }


def fetch_sold_matches(
    session,
    search: dict,
    timeout: int = 25,
    max_matches: int = 3,
    browser_runner=run_agent_browser,
    _rand=random.uniform,
    _choice=random.choice,
) -> dict:
    provider_result = soldcomps_sold_matches(session, search, max_matches=max_matches, timeout=timeout)
    if provider_result is not None:
        return provider_result

    def _request_headers():
        ua = os.environ.get("GOONERS_EBAY_USER_AGENT") or random_user_agent(_choice=_choice)
        return {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

    response = session.get(search["url"], headers=_request_headers(), timeout=timeout)

    if response.status_code == 429:
        sleep(_rand(BLOCK_BACKOFF_MIN, BLOCK_BACKOFF_MAX))
        response = session.get(search["url"], headers=_request_headers(), timeout=timeout)

    if response.status_code in {403, 429, 503}:
        browser_warning = ""
        if os.environ.get("GOONERS_EBAY_BROWSER_FALLBACK", "1").lower() in {"1", "true", "yes", "on"}:
            result = browser_sold_matches(search, max_matches=max_matches, browser_runner=browser_runner)
            if result["status"] != "blocked":
                return result
            browser_warning = f" Browser fallback: {result.get('warning', '')}".rstrip()
        return {
            "status": "blocked",
            "warning": f"eBay search returned HTTP {response.status_code}; stopping this ingestion run.{browser_warning}",
            "matches": [],
        }
    if response.status_code >= 400:
        return {
            "status": "error",
            "warning": f"eBay search returned HTTP {response.status_code}.",
            "matches": [],
        }

    matches = parse_sold_search_html(response.text, source_query=search["kind"], max_matches=max_matches)
    return {
        "status": "ok" if matches else "no_results",
        "warning": search.get("warning") or "",
        "matches": matches,
        "debug": page_debug_signature(response.text, fetched_via="http", http_status=response.status_code),
    }


def decimal_text(value) -> str:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        amount = Decimal("0")
    return f"{amount:.2f}"


def comp_rows_for_item(
    item: dict,
    search: dict,
    matches: list[dict],
    status: str,
    fetched_at: datetime | None = None,
    warning: str | None = None,
) -> list[dict]:
    fetched_at = fetched_at or datetime.now(timezone.utc)
    base = {
        "auction_safe_id": text_value(item.get("auctionSafeId")),
        "item_id": text_value(item.get("id")),
        "status": status,
        "query": text_value(search.get("query")),
        "search_url": text_value(search.get("url")),
        "fetched_at": fetched_at,
        "warning": warning or search.get("warning") or None,
        "auction_id": text_value(item.get("auctionId")),
        "lot_number": item.get("lotNumber") or 0,
        "cannons_title": text_value(item.get("title")),
        "cannons_description": text_value(item.get("description")),
        "current_bid": decimal_text(item.get("currentBid")),
        "total_bids": item.get("totalBids") or 0,
        "detail_url": text_value(item.get("detailUrl")),
    }

    if not matches:
        return [{
            **base,
            "ebay_item_id": None,
            "title": None,
            "price_value": None,
            "price_currency": None,
            "shipping_label": None,
            "sold_date": None,
            "sold_date_label": None,
            "thumbnail_url": None,
            "item_web_url": None,
            "condition": None,
            "source_query": search.get("kind"),
            "match_confidence": None,
            "raw_match_json": None,
        }]

    rows = []
    for match in matches:
        rows.append({
            **base,
            "status": "ok",
            "ebay_item_id": match.get("ebay_item_id"),
            "title": match.get("title"),
            "price_value": match.get("price_value"),
            "price_currency": match.get("price_currency") or "USD",
            "shipping_label": match.get("shipping_label"),
            "sold_date": match.get("sold_date"),
            "sold_date_label": match.get("sold_date_label"),
            "thumbnail_url": match.get("thumbnail_url"),
            "item_web_url": match.get("item_web_url"),
            "condition": match.get("condition"),
            "source_query": match.get("source_query") or search.get("kind"),
            "match_confidence": match.get("match_confidence") or "medium",
            "raw_match_json": json.dumps(match, sort_keys=True),
        })
    return rows


def comp_row_values(row: dict) -> tuple:
    return (
        row.get("auction_safe_id"),
        row.get("item_id"),
        row.get("status"),
        row.get("query"),
        row.get("search_url"),
        row.get("fetched_at"),
        row.get("warning"),
        row.get("ebay_item_id"),
        row.get("title"),
        row.get("price_value"),
        row.get("price_currency"),
        row.get("shipping_label"),
        row.get("sold_date"),
        row.get("sold_date_label"),
        row.get("thumbnail_url"),
        row.get("item_web_url"),
        row.get("condition"),
        row.get("source_query"),
        row.get("match_confidence"),
        row.get("auction_id"),
        row.get("lot_number"),
        row.get("cannons_title"),
        row.get("cannons_description"),
        row.get("current_bid"),
        row.get("total_bids"),
        row.get("detail_url"),
        row.get("raw_match_json"),
    )


def ensure_comp_tables(connection) -> None:
    connection.execute(CREATE_COMP_TABLE_SQL)
    connection.execute(PUBLIC_VIEW_SQL)


def insert_comp_rows(connection, rows: list[dict]) -> int:
    if not rows:
        return 0
    connection.executemany(INSERT_COMP_SQL, [comp_row_values(row) for row in rows])
    return len(rows)


def append_ebay_comp_snapshots(rows: list[dict], database: str | None = None) -> int:
    if not rows:
        return 0

    import warehouse

    connection = warehouse.connect(database, "append eBay comps to MotherDuck")
    try:
        ensure_comp_tables(connection)
        return insert_comp_rows(connection, rows)
    finally:
        connection.close()


def manifest_path(data_dir: Path = DATA_DIR, archived: bool = False) -> Path:
    return data_dir / ("archive-manifest.json" if archived else "manifest.json")


def manifest_item_path(entry: dict, data_dir: Path = DATA_DIR) -> Path:
    items_path = text_value(entry.get("itemsPath"))
    if not items_path:
        items_path = f"data/items/{entry.get('safeId')}.parquet"
    return data_dir.parent / items_path


def load_manifest_items(
    data_dir: Path = DATA_DIR,
    include_archived: bool = False,
    auction_safe_id: str | None = None,
) -> list[dict]:
    import pyarrow.parquet as pq

    items = []
    paths = [manifest_path(data_dir, archived=False)]
    if include_archived:
        paths.append(manifest_path(data_dir, archived=True))

    for path in paths:
        if not path.exists():
            continue

        manifest = json.loads(path.read_text())
        entries = manifest if isinstance(manifest, list) else manifest.get("auctions", [])
        for entry in entries:
            safe_id = text_value(entry.get("safeId") if isinstance(entry, dict) else entry)
            if auction_safe_id and safe_id != auction_safe_id:
                continue
            parquet_path = manifest_item_path(entry if isinstance(entry, dict) else {"safeId": safe_id}, data_dir)
            if not parquet_path.exists():
                continue
            table = pq.read_table(parquet_path)
            items.extend(table.to_pylist())

    items.sort(
        key=lambda item: (
            -float(item.get("currentBid") or 0),
            -int(item.get("totalBids") or 0),
            text_value(item.get("auctionSafeId")),
            int(item.get("lotNumber") or 0),
        )
    )
    return items


def normalize_match_row(row: dict) -> tuple[str, str, dict] | None:
    item_web_url = text_value(row.get("item_web_url"))
    title = text_value(row.get("title"))
    price_value = text_value(row.get("price_value"))

    if not title or not price_value or not is_ebay_item_url(item_web_url):
        return None

    auction_safe_id = text_value(row.get("auction_safe_id"))
    item_id = text_value(row.get("item_id"))
    if not auction_safe_id or not item_id:
        return None

    match = {
        "ebayItemId": text_value(row.get("ebay_item_id")) or None,
        "title": title,
        "price": {
            "value": price_value,
            "currency": text_value(row.get("price_currency"), "USD"),
        },
        "shippingLabel": text_value(row.get("shipping_label")) or None,
        "soldDate": text_value(row.get("sold_date")) or None,
        "soldDateLabel": text_value(row.get("sold_date_label")) or None,
        "thumbnailUrl": text_value(row.get("thumbnail_url")) or None,
        "itemWebUrl": item_web_url,
        "condition": text_value(row.get("condition")) or None,
        "sourceQuery": text_value(row.get("source_query")) or None,
        "matchConfidence": text_value(row.get("match_confidence")) or None,
    }
    return auction_safe_id, item_id, {k: v for k, v in match.items() if v is not None}


def build_public_exports(rows: list[dict], generated_at: str | None = None) -> dict[str, dict]:
    generated_at = generated_at or utc_now_text()
    exports: dict[str, dict] = {}

    for row in rows:
        normalized = normalize_match_row(row)
        if normalized is None:
            continue

        auction_safe_id, item_id, match = normalized
        auction_export = exports.setdefault(auction_safe_id, {
            "schemaVersion": 2,
            "generatedAt": generated_at,
            "marketplaceId": "EBAY_US",
            "source": "scraper",
            "items": {},
        })
        item_export = auction_export["items"].setdefault(item_id, {
            "status": text_value(row.get("status"), "ok"),
            "query": text_value(row.get("query")),
            "searchUrl": text_value(row.get("search_url")),
            "fetchedAt": text_value(row.get("fetched_at")) or generated_at,
            "warning": text_value(row.get("warning")) or None,
            "matches": [],
        })
        item_export["matches"].append(match)

    return exports


def write_comp_file(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def load_comp_file(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def empty_comp_export(generated_at: str) -> dict:
    return {
        "schemaVersion": 2,
        "generatedAt": generated_at,
        "marketplaceId": "EBAY_US",
        "source": "scraper",
        "items": {},
        "attempts": {},
    }


def parse_fetched_at(value: str) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def fresh_comp_keys_from_files(output_dir: Path, stale_hours: int) -> set[str]:
    """Return ``{auction_safe_id:item_id}`` for items fetched within stale_hours.

    Reads the ``attempts`` map (v2 files) and falls back to ``items`` fetch
    times (v1 files) so already-tried items - including ones that found no
    match - are not re-fetched until they go stale.
    """
    if stale_hours <= 0:
        return set()
    fresh = set()
    cutoff = datetime.now(timezone.utc).timestamp() - stale_hours * 3600
    for json_path in output_dir.glob("*.json"):
        payload = load_comp_file(json_path)
        if not payload:
            continue
        safe_id = json_path.stem
        records = {}
        records.update(payload.get("items", {}))
        records.update(payload.get("attempts", {}))
        for item_id, record in records.items():
            fetched_at = parse_fetched_at(record.get("fetchedAt", ""))
            if fetched_at is not None and fetched_at >= cutoff:
                fresh.add(f"{safe_id}:{item_id}")
    return fresh


def merge_comp_files(
    new_exports: dict[str, dict],
    attempts: dict[str, dict[str, dict]],
    output_dir: Path,
    generated_at: str,
) -> int:
    """Merge freshly fetched comps into the per-auction JSON read model.

    Only auctions touched this run are rewritten; existing files for untouched
    auctions are left exactly as they are. Within a touched auction, freshly
    matched items replace their prior entry, items whose latest fetch found no
    match are dropped, and every attempted item records its fetch time under
    ``attempts`` so it is not re-fetched until it goes stale.
    """
    touched = set(new_exports) | set(attempts)
    written = 0
    for safe_id in sorted(touched):
        path = output_dir / f"{safe_id}.json"
        payload = load_comp_file(path) or empty_comp_export(generated_at)
        payload.setdefault("items", {})
        payload.setdefault("attempts", {})
        payload["schemaVersion"] = 2
        payload["source"] = "scraper"
        payload["generatedAt"] = generated_at

        new_items = new_exports.get(safe_id, {}).get("items", {})
        for item_id, entry in new_items.items():
            payload["items"][item_id] = entry

        for item_id, attempt in attempts.get(safe_id, {}).items():
            payload["attempts"][item_id] = attempt
            if item_id not in new_items:
                payload["items"].pop(item_id, None)

        write_comp_file(path, payload)
        written += 1
    return written


def mirror_rows_to_warehouse(rows: list[dict]) -> int:
    """Best-effort append of comp rows to the optional warehouse mirror."""
    if not rows:
        return 0
    try:
        from warehouse import get_sink

        sink = get_sink()
        if sink is None:
            return 0
        mirrored = sink.append_comp_snapshots(rows)
        print(f"Mirrored {mirrored} eBay comp rows to the warehouse")
        return mirrored
    except Exception as exc:  # mirror is optional; never fail the read-model build
        print(f"Warehouse mirror skipped: {exc}")
        return 0


def fetch_direct(
    data_dir: Path = DATA_DIR,
    output_dir: Path = EBAY_COMPS_DIR,
    limit: int = DEFAULT_LIMIT,
    queries_per_item: int = 3,
    max_matches: int = 3,
    stale_hours: int = DEFAULT_STALE_HOURS,
    include_archived: bool = False,
    auction_safe_id: str | None = None,
    dry_run: bool = False,
    sleep_seconds: float = 1.0,
    mirror_to_warehouse: bool | None = None,
    request_session=None,
    _rand=random.uniform,
) -> dict:
    """Fetch eBay sold comps and accumulate them into the static JSON read model.

    The per-auction JSON files are the source of truth; the warehouse is an
    optional mirror written only when one is configured (``MOTHERDUCK_TOKEN``
    present, or ``mirror_to_warehouse=True``). No warehouse is required.
    """
    import requests

    summary = {
        "items_attempted": 0,
        "queries_attempted": 0,
        "matches": 0,
        "blocked": False,
        "files_written": 0,
    }
    if limit <= 0:
        return summary

    known_fresh = set() if dry_run else fresh_comp_keys_from_files(output_dir, stale_hours)
    session = request_session or requests.Session()
    generated_at = utc_now_text()
    all_rows: list[dict] = []
    attempts: dict[str, dict[str, dict]] = {}

    for item in load_manifest_items(
        data_dir=data_dir,
        include_archived=include_archived,
        auction_safe_id=auction_safe_id,
    ):
        safe_id = text_value(item.get("auctionSafeId"))
        item_id = text_value(item.get("id"))
        if f"{safe_id}:{item_id}" in known_fresh:
            continue

        searches = build_ebay_sold_searches(item)[:queries_per_item]
        if not searches:
            continue

        if summary["items_attempted"] >= limit:
            break
        summary["items_attempted"] += 1

        item_status = "no_results"
        last_debug = None  # TEMPORARY DIAGNOSTIC: signature of the last non-ok page
        for search in searches:
            result = fetch_sold_matches(session, search, max_matches=max_matches)
            rows = comp_rows_for_item(
                item,
                search,
                result["matches"],
                status=result["status"],
                fetched_at=generated_at,
                warning=result.get("warning"),
            )
            summary["queries_attempted"] += 1
            summary["matches"] += len(result["matches"])
            all_rows.extend(rows)
            if result.get("debug"):
                last_debug = {"queryKind": search.get("kind"), "query": search.get("query"), **result["debug"]}
            if result["status"] == "ok":
                # Got comps from this query — no need to spend further requests
                # on the broader fallback queries for this item.
                item_status = "ok"
                break
            if result["status"] == "blocked":
                summary["blocked"] = True
                print(result["warning"])
                break
            if sleep_seconds > 0:
                jitter_sleep(sleep_seconds, _rand=_rand)

        if safe_id and item_id and not summary["blocked"]:
            entry = {
                "fetchedAt": generated_at,
                "status": item_status,
            }
            if item_status != "ok" and last_debug:
                entry["debug"] = last_debug  # TEMPORARY DIAGNOSTIC
            attempts.setdefault(safe_id, {})[item_id] = entry

        if summary["blocked"]:
            break

    if dry_run:
        print(
            f"eBay comp fetch (dry run): {summary['items_attempted']} items, "
            f"{summary['queries_attempted']} queries planned"
        )
        return summary

    new_exports = build_public_exports(all_rows, generated_at)
    summary["files_written"] = merge_comp_files(new_exports, attempts, output_dir, generated_at)

    if mirror_to_warehouse is None:
        from motherduck import should_snapshot_to_motherduck
        mirror_to_warehouse = should_snapshot_to_motherduck()
    if mirror_to_warehouse:
        mirror_rows_to_warehouse(all_rows)

    print(
        f"eBay comp fetch: {summary['items_attempted']} items, "
        f"{summary['queries_attempted']} queries, {summary['matches']} matches, "
        f"{summary['files_written']} auction files updated"
    )
    return summary


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch eBay sold comps into the static read model"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_parser = subparsers.add_parser(
        "fetch-direct",
        help="Fetch eBay sold comps and accumulate them into JSON (warehouse optional)",
    )
    fetch_parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    fetch_parser.add_argument("--output-dir", type=Path, default=EBAY_COMPS_DIR)
    fetch_parser.add_argument(
        "--limit", type=int, default=int(os.environ.get("GOONERS_EBAY_COMPS_LIMIT", DEFAULT_LIMIT))
    )
    fetch_parser.add_argument("--queries-per-item", type=int, default=3)
    fetch_parser.add_argument("--max-matches", type=int, default=3)
    fetch_parser.add_argument("--stale-hours", type=int, default=DEFAULT_STALE_HOURS)
    fetch_parser.add_argument("--auction-safe-id", default=None)
    fetch_parser.add_argument("--include-archived", action="store_true")
    fetch_parser.add_argument("--dry-run", action="store_true")
    fetch_parser.add_argument(
        "--no-mirror",
        action="store_true",
        help="Do not mirror snapshots to the warehouse even when a token is present",
    )
    fetch_parser.add_argument("--sleep-seconds", type=float, default=1.0)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.command == "fetch-direct":
        fetch_direct(
            data_dir=args.data_dir,
            output_dir=args.output_dir,
            limit=args.limit,
            queries_per_item=args.queries_per_item,
            max_matches=args.max_matches,
            stale_hours=args.stale_hours,
            include_archived=args.include_archived,
            auction_safe_id=args.auction_safe_id,
            dry_run=args.dry_run,
            sleep_seconds=args.sleep_seconds,
            mirror_to_warehouse=False if args.no_mirror else None,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
