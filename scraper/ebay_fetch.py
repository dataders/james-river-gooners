"""eBay HTTP + browser fetch layer.

Handles the full fetch chain: SoldComps API first, then direct HTTP, then
agent-browser fallback on block. Parses eBay sold-search HTML into match dicts.
"""

import json
import os
import random
import re
import shlex
import subprocess
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from time import monotonic, sleep
from urllib.parse import parse_qs, urlparse

import telemetry
from ebay_util import normalize_spaces, text_value

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


def random_user_agent(_choice=random.choice) -> str:
    return _choice(USER_AGENTS)


# sold-comps.com reports remaining monthly quota on every /v1/scrape response
# (X-Usage-* / X-RateLimit-* headers) rather than via a separate endpoint, so
# these headers — not the comp ledger — are the authoritative meter.
USAGE_HEADER_PREFIXES = ("x-usage-", "x-ratelimit-", "x-rate-limit-")

# Candidate header names carrying the "requests remaining this period" count,
# most specific first. NOTE: the provider's exact spelling needs confirming
# against a live response (we can't authenticate from CI/tests); once the real
# header name is known, make sure it's listed here.
_REMAINING_HEADER_NAMES = (
    "x-usage-remaining",
    "x-usage-requests-remaining",
    "x-ratelimit-remaining",
    "x-rate-limit-remaining",
)


def extract_usage_headers(headers) -> dict:
    """Pull the provider's quota headers, lowercased, values kept as strings."""
    usage: dict[str, str] = {}
    try:
        items = list(headers.items())
    except (AttributeError, TypeError):
        # Missing/odd headers object (e.g. a bare test Mock) — no usage to read.
        return usage
    for name, value in items:
        low = str(name).lower()
        if low.startswith(USAGE_HEADER_PREFIXES):
            usage[low] = str(value)
    return usage


def usage_remaining(usage: dict) -> int | None:
    """Best-effort parse of the provider's remaining-quota header, or None."""
    for name in _REMAINING_HEADER_NAMES:
        if name in usage:
            try:
                return int(float(usage[name]))
            except (TypeError, ValueError):
                return None
    return None


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


def first_image_url(element) -> str:
    """Return the eBay thumbnail URL for a search-result card.

    eBay lazy-loads result images, so the real URL often lives in ``data-src``
    or ``srcset`` while ``src`` holds a 1×1 spacer. Prefer a concrete https URL.
    """
    selectors = (
        ".s-item__image-img",
        ".s-card__image",
        ".s-item__image img",
        "img",
    )
    for selector in selectors:
        for img in element.select(selector):
            for attr in ("src", "data-src", "data-defer-load"):
                value = str(img.get(attr) or "")
                if value.startswith("http"):
                    return value
            srcset = str(img.get("srcset") or "")
            if srcset:
                first = srcset.split(",")[0].strip().split(" ")[0]
                if first.startswith("http"):
                    return first
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
        image_url = first_image_url(card)

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

    query_kind = search.get("kind", "")
    started = monotonic()
    try:
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
    except OSError as exc:
        # A request that never reached the provider isn't billed, but record it
        # so transport failures are visible in telemetry alongside billed calls.
        telemetry.capture(
            "soldcomps_api_request",
            {
                "status": "exception",
                "query_kind": query_kind,
                "error": type(exc).__name__,
                "latency_ms": round((monotonic() - started) * 1000),
            },
        )
        return None

    usage = extract_usage_headers(response.headers)
    remaining = usage_remaining(usage)
    latency_ms = round((monotonic() - started) * 1000)

    def _emit(status: str, matched: int) -> None:
        telemetry.capture(
            "soldcomps_api_request",
            {
                "status": status,
                "http_status": response.status_code,
                "query_kind": query_kind,
                "matched_count": matched,
                "latency_ms": latency_ms,
                "provider_remaining": remaining,
                # Forward the raw quota headers (x-usage-* → x_usage_*) so the
                # provider's exact accounting is queryable in PostHog.
                **{key.replace("-", "_"): value for key, value in usage.items()},
            },
        )

    if response.status_code >= 400:
        _emit("error", 0)
        return {
            "status": "error",
            "warning": f"SoldComps API returned HTTP {response.status_code}.",
            "matches": [],
            "usage": usage,
            "provider_remaining": remaining,
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

    status = "ok" if matches else "no_results"
    _emit(status, len(matches))
    return {
        "status": status,
        "warning": search.get("warning") or "",
        "matches": matches,
        "usage": usage,
        "provider_remaining": remaining,
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
        }

    matches = parse_sold_search_html(html, source_query=search["kind"], max_matches=max_matches)
    return {
        "status": "ok" if matches else "no_results",
        "warning": search.get("warning") or "",
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
    }
