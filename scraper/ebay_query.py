"""eBay sold-comp query generation.

Builds search queries from auction lot metadata — exact-phrase primary query
(enrichment-derived or title/description), broad token fallback, and category
fallback. Pure logic: no I/O, no HTTP.
"""

import os
import re
from pathlib import Path
from urllib.parse import urlencode

import yaml
from ebay_util import normalize_spaces

EBAY_SEARCH_URL = "https://www.ebay.com/sch/i.html"

# Always-safe /v1/scrape constraints applied to EVERY funnel tier: US
# marketplace, US-only sellers, most-recently-sold first, a sub-$5 junk floor,
# and a wide candidate set (for a future hybrid re-rank). These never reduce
# recall in a way that would empty a tier, so they ride along on broad/category
# too. (minPrice/count are env-overridable at call time; see the builder.)
_EBAY_SORT_ORDER = "endedRecently"
_EBAY_SITE = "ebay.com"
_EBAY_ITEM_LOCATION = "domestic"
_EBAY_DEFAULT_MIN_PRICE = 5
_EBAY_DEFAULT_COUNT = 40

# Enrichment `condition` (new|open box|used|for parts|unknown) → the /v1/scrape
# `itemCondition` enum (only any|new|used exist; there's no granular conditionId
# query param). "unknown"/absent maps to "" so the constraint is omitted.
_EBAY_CONDITION_MAP = {
    "new": "new",
    "open box": "new",
    "used": "used",
    "for parts": "used",
}

_CATEGORY_IDS_PATH = Path(__file__).resolve().parent / "ebay_category_ids.yml"
_CATEGORY_IDS_CACHE: dict[str, str] | None = None


def _load_category_ids() -> dict[str, str]:
    """Load (and cache) the GROUP → eBay L1 categoryId map.

    Mirrors categories.py's YAML pattern (path relative to this file,
    ``yaml.safe_load``). Tolerates a missing/empty file by returning ``{}`` so
    an absent map degrades to "no category filter" rather than raising.
    """
    global _CATEGORY_IDS_CACHE
    if _CATEGORY_IDS_CACHE is None:
        try:
            with open(_CATEGORY_IDS_PATH) as handle:
                loaded = yaml.safe_load(handle) or {}
        except FileNotFoundError:
            loaded = {}
        _CATEGORY_IDS_CACHE = {str(key): str(value) for key, value in loaded.items()}
    return _CATEGORY_IDS_CACHE


def ebay_category_id(item: dict) -> str:
    """eBay L1 categoryId string for the lot's broad ``category`` group.

    Returns the mapped id, or ``""`` when the group is absent or unmapped. A
    mapped ``"0"`` (deliberate "no filter") is returned verbatim — the builder
    treats both ``""`` and ``"0"`` as "omit the categoryId param".
    """
    group = str(item.get("category") or "").strip()
    if not group:
        return ""
    return _load_category_ids().get(group, "")


def ebay_item_condition(item: dict) -> str:
    """Collapse the enrichment ``condition`` field to the /v1/scrape enum.

    new/open box → ``"new"``; used/for parts → ``"used"``; unknown/empty/missing
    → ``""`` (so the constraint is omitted, not sent as a guessed value).
    """
    condition = str(item.get("condition") or "").strip().lower()
    return _EBAY_CONDITION_MAP.get(condition, "")


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


def clean_comp_text(raw_text: str) -> str:
    cleaned = raw_text or ""
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


def compact_item_text(item: dict) -> str:
    raw_text = " ".join(
        str(part)
        for part in (
            item.get("description"),
            ""
            if re.match(r"^lot\s*-", str(item.get("title", "")), re.IGNORECASE)
            else item.get("title"),
            item.get("rawCategory"),
        )
        if part
    )
    return clean_comp_text(raw_text)


def item_exact_phrase(item: dict, max_words: int = 6) -> str:
    """Quoted exact-phrase query from the lot's most descriptive contiguous text.

    Prefers the real title; falls back to description when title is a
    "Lot - N" placeholder. Returns "" when there's no usable multi-word phrase.
    """
    title = str(item.get("title") or "")
    if title.strip() and not re.match(r"^lot\s*-", title, re.IGNORECASE):
        source = title
    else:
        source = str(item.get("description") or "")
    words = [word for word in clean_comp_text(source).split(" ") if word][:max_words]
    if len(words) < 2:
        return ""
    return '"' + " ".join(words) + '"'


def enriched_exact_phrase(item: dict, max_words: int = 8) -> str:
    """Primary eBay query from LLM enrichment (medium/high confidence only).

    Prefers the model-composed ``searchQuery`` (v3) — a short brand + model +
    type + attribute phrase tuned for eBay sold search — used unquoted so eBay
    AND-matches the terms. Falls back to a quoted ``brand model`` phrase for older
    rows without a search query. Returns "" when enrichment is absent,
    low-confidence, or too thin, so junk enrichment never worsens comps.
    """
    if str(item.get("enrichmentConfidence") or "").lower() not in ("medium", "high"):
        return ""
    search_query = clean_comp_text(str(item.get("searchQuery") or ""))
    if search_query:
        words = [word for word in search_query.split(" ") if word][:max_words]
        if len(words) >= 2:
            return " ".join(words)
    # Legacy fallback: quoted brand + model exact phrase.
    brand = clean_comp_text(str(item.get("brand") or ""))
    model = clean_comp_text(str(item.get("modelOrSku") or ""))
    words = [word for word in normalize_spaces(f"{brand} {model}").split(" ") if word][
        :max_words
    ]
    if len(words) < 2:
        return ""
    return '"' + " ".join(words) + '"'


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
    params = urlencode(
        {
            "_nkw": query,
            "LH_Sold": "1",
            "LH_Complete": "1",
            "_sop": "13",
        }
    )
    return f"{EBAY_SEARCH_URL}?{params}"


def build_ebay_sold_searches(item: dict, leaf_category_id: str = "") -> list[dict]:
    text = compact_item_text(item)
    tokens = meaningful_tokens(text)
    model_tokens = [
        token
        for token in tokens
        if re.search(r"[A-Za-z]\d|\d[A-Za-z]|[-/]\d", token) and len(token) >= 4
    ]
    # Keep queries short — eBay sold-listing searches return nothing for long,
    # over-specific keyword strings. Funnel from precise down to broad fallbacks.
    broad_tokens = [token for token in tokens if not re.match(r"^\d+$", token)][:3]
    specific_tokens = dedupe_words(tokens[:4] + model_tokens)[:5]
    category_tokens = meaningful_tokens(
        f"{item.get('rawCategory') or item.get('category') or ''} {text}"
    )[:4]

    # Primary: quoted exact phrase (enrichment-derived or title/description).
    # Broad/category recover recall when the exact phrase returns nothing.
    specific_query = (
        enriched_exact_phrase(item)
        or item_exact_phrase(item)
        or " ".join(specific_tokens)
    )

    candidates = [
        {"kind": "specific", "label": "Specific match", "query": specific_query},
        {"kind": "broad", "label": "Broader match", "query": " ".join(broad_tokens)},
        {
            "kind": "category",
            "label": "Category match",
            "query": " ".join(dedupe_words(category_tokens)),
        },
    ]
    warning = (
        "eBay may return limited results for restricted categories."
        if item.get("category") in RESTRICTED_CATEGORIES
        else ""
    )

    # Always-safe constraints ride on EVERY tier; numeric floors are
    # env-overridable at call time. The precise-only constraints (categoryId +
    # itemCondition) are attached to the `specific` tier alone, so when the
    # tightly-filtered specific query returns nothing the existing funnel falls
    # through to broad/category — which carry only the safe constraints. That's
    # graceful degradation for free, with no new retry logic.
    def _env_int(name: str, default: int) -> int:
        try:
            return int(os.environ.get(name, "") or default)
        except ValueError:
            return default

    safe_filters = {
        "min_price": _env_int("GOONERS_EBAY_COMPS_MIN_PRICE", _EBAY_DEFAULT_MIN_PRICE),
        "sort_order": _EBAY_SORT_ORDER,
        "ebay_site": _EBAY_SITE,
        "item_location": _EBAY_ITEM_LOCATION,
        "count": _env_int("GOONERS_EBAY_COMPS_COUNT", _EBAY_DEFAULT_COUNT),
    }
    category_id = leaf_category_id or ebay_category_id(item)
    item_condition = ebay_item_condition(item)
    specific_filters = {}
    if category_id and category_id != "0":
        specific_filters["category_id"] = category_id
    if item_condition:
        specific_filters["item_condition"] = item_condition

    searches = []
    seen = set()
    for candidate in candidates:
        query = normalize_spaces(candidate["query"])
        key = query.lower()
        if not query or key in seen:
            continue
        seen.add(key)
        searches.append(
            {
                **candidate,
                "query": query,
                "url": build_ebay_sold_search_url(query),
                "warning": warning,
                **safe_filters,
                **(specific_filters if candidate["kind"] == "specific" else {}),
            }
        )
    return searches
