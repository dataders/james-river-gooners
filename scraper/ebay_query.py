"""eBay sold-comp query generation.

Builds search queries from auction lot metadata — exact-phrase primary query
(enrichment-derived or title/description), broad token fallback, and category
fallback. Pure logic: no I/O, no HTTP.
"""

import re
from urllib.parse import urlencode

from ebay_util import normalize_spaces

EBAY_SEARCH_URL = "https://www.ebay.com/sch/i.html"

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
            "" if re.match(r"^lot\s*-", str(item.get("title", "")), re.IGNORECASE) else item.get("title"),
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


def enriched_exact_phrase(item: dict, max_words: int = 6) -> str:
    """Quoted ``brand model`` exact-phrase from LLM enrichment (medium/high confidence only).

    Returns "" when enrichment is absent, low-confidence, or produces fewer
    than two words — so junk enrichment never worsens comps.
    """
    if str(item.get("enrichmentConfidence") or "").lower() not in ("medium", "high"):
        return ""
    brand = clean_comp_text(str(item.get("brand") or ""))
    model = clean_comp_text(str(item.get("modelOrSku") or ""))
    words = [word for word in normalize_spaces(f"{brand} {model}").split(" ") if word][:max_words]
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
    # over-specific keyword strings. Funnel from precise down to broad fallbacks.
    broad_tokens = [token for token in tokens if not re.match(r"^\d+$", token)][:3]
    specific_tokens = dedupe_words(tokens[:4] + model_tokens)[:5]
    category_tokens = meaningful_tokens(f"{item.get('rawCategory') or item.get('category') or ''} {text}")[:4]

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
