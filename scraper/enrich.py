#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
#     "pyarrow",
#     "pydantic-settings>=2,<3",
# ]
# ///
"""
LLM metadata enrichment for auction lots.

After a scrape, each lot has a title, a free-text description, a category, and a
few image URLs — but the fields that actually make a good eBay sold-comp query
(brand + model/SKU) are buried in prose or, for Cannon's "Other" lots, absent
from the title entirely (it's a ``Lot - N`` placeholder; the detail lives in the
description). This module asks Claude Haiku to read each lot (its text plus the
first photo) and pull out structured resale metadata — brand, model_or_sku,
condition, a canonical product_url, and a confidence — then writes those fields
back onto the item dict so they persist to the NDJSON/Parquet read model
alongside everything else.

Two consumers:
  * ``ebay_comps.build_ebay_sold_searches`` uses ``brand`` + ``modelOrSku`` as
    the primary exact-phrase query when confidence is medium or high (#99). Low
    confidence falls through to the existing description/token-bag query, so
    junk enrichment of a generic lot never makes comps worse than before.
  * the UI (#104 authenticator sidebar) displays the fields regardless of
    confidence.

Graceful degradation is the whole point: enrichment runs only when opted in
(``GOONERS_ENRICHMENT=1``) AND an ``ANTHROPIC_API_KEY`` is present AND the
``anthropic`` SDK is importable. Miss any of those and ``enrich_items`` is a
silent no-op, so the scrape, the static site, and CI all behave exactly as
before. API cost is negligible (a full ~500-lot Cannon's auction enriches for
well under $0.10 on Haiku), but it's off by default so output quality can be
validated before it becomes a standing cost on every scheduled scrape.

    python enrich.py <safe_id> [<safe_id> ...]            # backfill (synchronous)
    python enrich.py --batch <safe_id> [<safe_id> ...]   # backfill via the Message
        Batches API at 50% cost. Photos are inlined as base64 (needs ``requests``
        + ``pillow``) rather than sent by URL — Anthropic fetching image URLs is
        capped by an org-wide ~100 RPM URL Content Fetching limit that batches do
        NOT lift, so a batch of URL images would mostly return rate_limit_error.
        A batch can take up to 24h, so the live scrape path stays synchronous.
    python enrich.py --batch --all                        # every auction across the
        active AND archive read models. Named ids also resolve in either dir.
    python enrich.py --enrich 1 <safe_id>                 # set the GOONERS_ENRICHMENT
        gate via flag instead of exporting the env var (running the backfill *is*
        the intent to enrich). Bare ``--enrich`` means 1; ``--enrich 0`` forces the
        no-op path. ``ANTHROPIC_API_KEY`` is still required.

Backfill spans active + archive, rewrites the NDJSON/Parquet read model, then
mirrors the identified lots into the Supabase ``lot_enrichment`` table (a no-op
without ``SUPABASE_SECRET_KEY``). For the batch path add ``--with anthropic
--with requests --with pillow``.
"""

import concurrent.futures
import hashlib
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

import env_secrets as secrets
from config import EnrichmentSettings as _EnrichmentSettings

# Server-side PostHog telemetry for the enrichment runs (batch + sync). Reuses the
# shared scraper helper (scraper/telemetry.py) — itself a silent no-op unless
# GOONERS_POSTHOG_KEY is set AND the posthog SDK imports, and it never raises into
# the caller. Guarded so a missing module can never break a scrape/backfill.
try:
    from telemetry import capture as _telemetry_capture
    from telemetry import flush as _telemetry_flush
except Exception:  # pragma: no cover - telemetry is best-effort

    def _telemetry_capture(event, properties=None):
        return None

    def _telemetry_flush():
        return None


def _chunk_safe_id(items: list[dict]) -> str | None:
    """The auction a unit of work covers — best-effort, for the cost ledger.
    Backfills/scrapes process one auction at a time so a chunk is single-auction;
    return None when a chunk happens to span auctions (don't mislabel the row)."""
    ids = {item.get("auctionSafeId") for item in items if item.get("auctionSafeId")}
    return next(iter(ids)) if len(ids) == 1 else None


def _record_enrich_run(payload: dict) -> None:
    """Append one row to the Supabase ``enrich_runs`` cost ledger. Best-effort:
    a no-op when Supabase is unconfigured, and warns (never raises) on failure —
    the enrichment itself is the deliverable, not the ledger entry."""
    try:
        from supabase_enrichment import record_enrich_run
    except Exception:  # pragma: no cover - supabase deps optional
        return
    try:
        record_enrich_run(payload)
    except Exception as exc:  # noqa: BLE001 - ledger is best-effort
        print(
            f"  WARNING: failed to record enrich_runs ledger row: {exc}",
            file=sys.stderr,
        )


# Runtime-tunable knobs are read at call time (not import time) via fresh
# _EnrichmentSettings() calls so patch.dict(os.environ, ...) works in tests.
# See item_image_urls, enrichment_fingerprint, build_request_params, enrich_items,
# enrich_items_batch, and _run_one_batch for the per-function reads.

# Concurrent workers blow through a low per-minute org rate limit, so lean on
# the SDK's built-in 429 handling (honors retry-after). A generous retry count
# lets a lot ride out the rate-limit window without being dropped.
MAX_RETRIES = 8
# Batch API polling / wait budget — implementation details, not operator knobs.
BATCH_POLL_INTERVAL = 30.0
BATCH_MAX_WAIT = float(24 * 3600)
# Downscale inlined images for the batch payload. 512px is plenty for product
# identity extraction; 768px gave no measurable lift in testing.
MAX_IMAGE_PX = 512
IMAGE_FETCH_WORKERS = 16
# Pre-flight cost estimation (--estimate-only). Haiku 4.5 list price per million
# tokens; the Batches API is 50% off.
PRICE_IN_PER_MTOK = 1.0
PRICE_OUT_PER_MTOK = 5.0
ESTIMATE_SAMPLE = 30
ESTIMATE_OUTPUT_TOKENS = 300


def _text_only() -> bool:
    """Text-only mode (``--text-only`` / GOONERS_ENRICHMENT_TEXT_ONLY=1): drop the
    photos and enrich from the lot's text alone — much cheaper, for backfilling a
    text-derivable field across history without re-paying the image tokens. Read
    at call time (not import) so the CLI flag can set it before any enrichment."""
    return _EnrichmentSettings().text_only


# Bump when the prompt/schema changes so every lot re-enriches once instead of
# reusing a now-stale cached row (the fingerprint folds this in). v5: adds a
# freeform `notes` catch-all (future text-derivable fields can be mined from it
# cheaply via --text-only, without re-reading the photos).
ENRICHMENT_SCHEMA_VERSION = "6"

# Fields written onto each item, camelCase to match the rest of the read model
# (lotNumber, currentBid, rawCategory, …). `enrichmentModel` records which model
# produced the row (provenance for the Supabase API / future re-runs).
# `enrichmentInputHash` fingerprints the inputs that produced the row (schema +
# model + image size + text + photos) so a later scrape can reuse an unchanged
# lot's enrichment instead of paying for an identical API call (see `enrich_items`).
# Search-oriented (v3): `modelOrSku` holds the model *name* (product line, looser
# than a SKU), `productType` the noun, and `searchQuery` the model's best eBay
# sold-comp phrase. `brandConfidence`/`modelConfidence` are scored separately (a
# confident brand is useful even without a model); `enrichmentConfidence` is their
# max, the overall bar the Supabase mirror + UI use. Lot economics + resale risk
# (v4): `quantity` (item count as a digit string, "" if indeterminate),
# `isMixedLot` ("true"/"false" — a box of *different* items vs many identical),
# `conditionFlags` + `keyAttributes` (JSON-encoded string lists, "" when empty, so
# the Parquet column stays a uniform string like `images`). Multi-brand lots
# (Option B): `secondaryItems` — a JSON-encoded list of the *other* identifiable
# products beyond the primary one ({brand, modelOrSku, productType, searchQuery}
# each), "" when none, so a junk-drawer lot yields a comp per distinct product.
# Category-aware details (v6): `detailCategory` is the lot's kind (furniture/art/
# ceramics_glass/other) and `details` is a JSON-encoded object of the *resale-
# identifying* keys for that category — furniture: style/material/form; art:
# artist/medium/subject; ceramics_glass: maker/pattern/material — for unbranded
# lots whose identity is descriptive rather than brand+model (an antique table, a
# signed painting). `detailConfidence` is scored separately and folds into
# `enrichmentConfidence` (= max of brand/model/detail), so a confident
# style/artist clears the display+comp bar even with no brand. The model composes
# `searchQuery` from these keys when brand is empty. "" / "{}" when not applicable.
ENRICHMENT_FIELDS = (
    "brand",
    "modelOrSku",
    "productType",
    "searchQuery",
    "condition",
    "productUrl",
    "quantity",
    "isMixedLot",
    "conditionFlags",
    "keyAttributes",
    "secondaryItems",
    "notes",
    "detailCategory",
    "details",
    "brandConfidence",
    "modelConfidence",
    "detailConfidence",
    "enrichmentConfidence",
    "enrichmentModel",
    "enrichmentSchemaVersion",
    "enrichmentInputHash",
)
CONDITION_VALUES = ("new", "open box", "used", "for parts", "unknown")
CONFIDENCE_VALUES = ("low", "medium", "high")
# Closed set of resale-risk flags the model may tag a lot with (any subset).
CONDITION_FLAG_VALUES = (
    "untested",
    "damaged",
    "missing parts",
    "repaired",
    "incomplete",
)
# Cap on stored key attributes (the model is asked for the few most identifying).
MAX_KEY_ATTRIBUTES = 6
# Cap on stored secondary products (multi-brand lots — the rest beyond the primary).
MAX_SECONDARY_ITEMS = 4
# The per-product sub-fields stored for each secondary item (camelCase read model).
SECONDARY_ITEM_FIELDS = ("brand", "modelOrSku", "productType", "searchQuery")
# Category-aware detail keys (v6). The model picks one detailCategory and fills the
# keys that carry resale identity for it (the value driver for unbranded lots).
# `other` fills nothing — those lots rely on the brand/model path or stay generic.
DETAIL_CATEGORY_VALUES = ("furniture", "art", "ceramics_glass", "other")
DETAIL_KEYS_BY_CATEGORY = {
    "furniture": ("style", "material", "form"),
    "art": ("artist", "medium", "subject"),
    "ceramics_glass": ("maker", "pattern", "material"),
    "other": (),
}
# Superset of every detail key, in stable order — the `details` schema object
# carries all of them (so json_schema stays additionalProperties:false with every
# key required); parsing prunes to the chosen category's keys and drops empties.
DETAIL_SUPERSET_KEYS = (
    "style",
    "material",
    "form",
    "artist",
    "medium",
    "subject",
    "maker",
    "pattern",
)
# Rank for taking the max of the per-field confidences.
_CONFIDENCE_RANK = {"": 0, "low": 1, "medium": 2, "high": 3}

# Structured-output schema (json_schema). Haiku 4.5 supports structured outputs;
# enums keep condition/confidences/flags on the closed value sets above. Every
# field is required and additionalProperties is false, so the response is always
# parseable.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string"},
        "model_name": {"type": "string"},
        "product_type": {"type": "string"},
        "search_query": {"type": "string"},
        "quantity": {"type": "integer"},
        "is_mixed_lot": {"type": "boolean"},
        "condition": {"type": "string", "enum": list(CONDITION_VALUES)},
        "condition_flags": {
            "type": "array",
            "items": {"type": "string", "enum": list(CONDITION_FLAG_VALUES)},
        },
        "key_attributes": {"type": "array", "items": {"type": "string"}},
        # Other identifiable products in a multi-brand lot (the primary fields
        # above describe the single most prominent/valuable item).
        "secondary_items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "brand": {"type": "string"},
                    "model_name": {"type": "string"},
                    "product_type": {"type": "string"},
                    "search_query": {"type": "string"},
                },
                "required": ["brand", "model_name", "product_type", "search_query"],
                "additionalProperties": False,
            },
        },
        "notes": {"type": "string"},
        # Category-aware detail (v6). `detail_category` selects the kind of lot;
        # `details` carries the superset of keys (fill only the chosen category's),
        # so unbranded furniture/art/ceramics get a resale identity.
        "detail_category": {"type": "string", "enum": list(DETAIL_CATEGORY_VALUES)},
        "details": {
            "type": "object",
            "properties": {key: {"type": "string"} for key in DETAIL_SUPERSET_KEYS},
            "required": list(DETAIL_SUPERSET_KEYS),
            "additionalProperties": False,
        },
        "detail_confidence": {"type": "string", "enum": list(CONFIDENCE_VALUES)},
        "product_url": {"type": "string"},
        "brand_confidence": {"type": "string", "enum": list(CONFIDENCE_VALUES)},
        "model_confidence": {"type": "string", "enum": list(CONFIDENCE_VALUES)},
    },
    "required": [
        "brand",
        "model_name",
        "product_type",
        "search_query",
        "quantity",
        "is_mixed_lot",
        "condition",
        "condition_flags",
        "key_attributes",
        "secondary_items",
        "notes",
        "detail_category",
        "details",
        "detail_confidence",
        "product_url",
        "brand_confidence",
        "model_confidence",
    ],
    "additionalProperties": False,
}

SYSTEM_PROMPT = (
    "You identify consumer products from auction-lot listings and write the best "
    "eBay *sold-listing* search for each, so resale buyers can see comps. You are "
    "given the lot's text and up to a few photos. Extract:\n"
    '- brand: the manufacturer or brand (e.g. "DeWalt", "KitchenAid"). Empty '
    "string if none is identifiable.\n"
    '- model_name: the product line or model name — e.g. "Artisan", "SawStop '
    'PCS", "Speedmaster". Prefer a recognizable name over a raw SKU; a precise '
    "model number is great when clearly present, but don't strain for one. Empty "
    "string if not identifiable.\n"
    '- product_type: the general product noun (e.g. "stand mixer", "table '
    'saw", "dive watch", "humidor"). Almost always fillable from the text.\n'
    "- search_query: the search phrase you would type into eBay sold listings to "
    "find this exact item's comps. Compose it from brand + model_name + "
    "product_type plus the one or two most identifying attributes (size, "
    'capacity, material, wattage, era) — e.g. "KitchenAid Artisan 5 qt stand '
    'mixer", "Craftsman 20V cordless drill". Keep it short (3-7 words), no lot '
    'numbers or filler. If the lot is generic/mixed (e.g. "box of assorted '
    'hardware"), return an empty string.\n'
    "- quantity: how many items the lot contains, as a whole number. A single "
    "photo often shows several items — count them. Use the count when the lot is "
    "multiple of the *same* item (e.g. 12 identical mugs -> 12) or a stated set "
    '("set of 4" -> 4). Use 1 for a single item. Use 0 only when the count truly '
    "can't be determined.\n"
    "- is_mixed_lot: true when the lot is an assortment of *different* items (a "
    "junk drawer, a box of unrelated goods) rather than one item or many identical "
    "ones. For a mixed lot, set the primary brand/model_name/product_type/"
    "search_query to the single most prominent or valuable identifiable item and "
    "list the OTHER identifiable products in secondary_items. If nothing in the "
    "lot is identifiable (generic junk), leave the primary fields empty and score "
    "low.\n"
    "- secondary_items: the other distinct, identifiable products in a multi-brand "
    "lot beyond the primary one above — each with its own brand, model_name, "
    "product_type, and search_query (same rules as the primary fields). Empty "
    "array for a single product or many identical items. Include only items worth "
    "comping on their own; skip filler.\n"
    "- condition: one of new, open box, used, for parts, unknown.\n"
    "- condition_flags: any of untested, damaged, missing parts, repaired, "
    'incomplete that the listing states or the photos clearly show (e.g. "AS-IS, '
    'untested", a visible crack). Empty array if none are indicated — do not '
    "guess.\n"
    "- key_attributes: up to the few most search-identifying specs (size, "
    'capacity, material, color, dimensions, wattage, era) — e.g. ["5 qt", '
    '"stainless steel"]. Empty array if nothing distinctive.\n'
    "- notes: a brief freeform line capturing any other identifying or "
    "resale-relevant detail not already in the fields above — maker's marks, "
    "signatures, stamps, hallmarks, serial/pattern numbers, provenance, era cues, "
    "or notable flaws. This is a catch-all so later searches can mine it; keep it "
    "to one sentence. Empty string if there's nothing to add.\n"
    "- detail_category: the lot's kind, one of: furniture, art, ceramics_glass, "
    "other. Pick the one whose descriptive identity (not its brand) is what a "
    'resale buyer would search on. Use "other" for branded consumer goods, '
    "tools, electronics, jewelry, collectibles, or anything that doesn't fit.\n"
    "- details: an object. Fill ONLY the keys for the detail_category you chose, "
    'leave the rest empty strings. furniture -> style (e.g. "mid-century '
    'modern", "Victorian", "Art Deco"), material (e.g. "walnut", '
    '"brass"), form (the piece, e.g. "credenza", "side chair"). art -> '
    "artist (the signed/attributed name if legible, else empty), medium (e.g. "
    '"oil on canvas", "watercolor"), subject (e.g. "winter landscape"). '
    'ceramics_glass -> maker (e.g. "Lladro", "Delft"), pattern (e.g. "Olde '
    'England"), material (e.g. "transferware", "cut crystal"). other -> '
    "leave all keys empty. Only fill a key from what the text/photos actually "
    "show — do NOT guess an artist, an era, or a maker.\n"
    "- detail_confidence: high when the detail keys clearly capture the lot's "
    "identity, medium when reasonably sure, low for vague/generic. Score "
    "independently of brand/model. For an unbranded furniture/art/ceramics lot "
    "this is what carries the identification, so when you fill details "
    'confidently, also compose search_query from those keys (e.g. "mid-century '
    'walnut credenza", "Helen Lord watercolor winter landscape", "Delft blue '
    'transferware plate") even though brand/model are empty.\n'
    "- product_url: a canonical manufacturer/major-retailer product page URL ONLY "
    "if you are certain it is real; otherwise an empty string (a hallucinated URL "
    "is worse than none).\n"
    "- brand_confidence: high when the brand is clearly identifiable, medium when "
    "reasonably sure, low for generic/mixed/ambiguous lots.\n"
    "- model_confidence: the same scale for the model_name/search specificity, "
    "scored independently (you may know the brand confidently yet not the model).\n"
    "Never invent details. Base everything on the text and photos."
)


def is_enrichment_enabled() -> bool:
    """True only when the user opted in AND a key is present. The opt-in keeps
    enrichment off by default (no surprise API spend on every scrape).

    Reads from EnrichmentSettings so "1"/"true"/"yes"/"on" all work (previously
    only "1" was accepted, silently treating GOONERS_ENRICHMENT=true as OFF)."""
    return _EnrichmentSettings().enabled and bool(secrets.anthropic_key())


def _empty_enrichment() -> dict:
    return dict.fromkeys(ENRICHMENT_FIELDS, "")


def _make_client():
    """Construct an Anthropic client, or None if the SDK isn't installed. Import
    is local so importing this module never requires the `anthropic` package."""
    try:
        import anthropic
    except ImportError:
        print(
            "  enrich: anthropic SDK not installed; skipping enrichment",
            file=sys.stderr,
        )
        return None
    return anthropic.Anthropic(max_retries=MAX_RETRIES)


class _RateLimiter:
    """Spaces calls across threads to stay under a requests-per-minute ceiling.

    Each ``acquire`` reserves the next time slot (advancing a shared cursor under
    a lock) and sleeps until it, so N worker threads issue at most ``rpm``
    requests per minute combined. ``rpm <= 0`` disables throttling entirely."""

    def __init__(self, rpm: float):
        self._min_interval = 60.0 / rpm if rpm > 0 else 0.0
        self._lock = threading.Lock()
        self._next = 0.0

    def acquire(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            scheduled = max(now, self._next)
            self._next = scheduled + self._min_interval
            wait = scheduled - now
        if wait > 0:
            time.sleep(wait)


_limiter = _RateLimiter(_EnrichmentSettings().rpm)


def item_images(item: dict) -> list:
    """Normalize the lot's images to a list of URLs. Items carry images as a
    real array pre-Parquet (during a scrape) and as a JSON string in Parquet /
    when reloaded — accept both."""
    images = item.get("images")
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except (ValueError, TypeError):
            return []
    return images if isinstance(images, list) else []


def item_prompt_text(item: dict) -> str:
    """The lot's identifying text. Skips ``Lot - N`` placeholder titles (the real
    detail is in the description for those), mirroring ebay_comps."""
    title = str(item.get("title") or "").strip()
    lines = []
    if title and not re.match(r"^lot\s*-", title, re.IGNORECASE):
        lines.append(f"Title: {title}")
    description = str(item.get("description") or "").strip()
    if description:
        lines.append(f"Description: {description}")
    category = str(item.get("rawCategory") or item.get("category") or "").strip()
    if category:
        lines.append(f"Category: {category}")
    return "\n".join(lines) if lines else "(no text provided)"


def item_image_urls(item: dict, limit: int | None = None) -> list[str]:
    """The first ``limit`` http(s) photo URLs (#152). Many lots put the model/SKU
    plate on photo 2 or 3, so enrichment reads several, not just the first. Empty
    in text-only mode — the single chokepoint that makes the sync path, batch
    image-fetch, and fingerprint all drop images at once."""
    if _text_only():
        return []
    if limit is None:
        limit = max(1, _EnrichmentSettings().max_images)
    urls = []
    for raw in item_images(item):
        url = str(raw)
        if url.startswith(("http://", "https://")):
            urls.append(url)
        if len(urls) >= limit:
            break
    return urls


def first_image_url(item: dict) -> str:
    """The first http(s) photo URL, or "" (kept for callers that want just one)."""
    urls = item_image_urls(item, limit=1)
    return urls[0] if urls else ""


def enrichment_fingerprint(item: dict) -> str:
    """Stable hash of everything that feeds an enrichment call: the schema
    version, the model, the inline-image downscale size, the lot's identifying
    text, and its photos. Two lots with the same fingerprint get an identical API
    result, so the prior one can be reused. Folding in the schema version + image
    set + size means a prompt/schema change, a new photo count, or a resolution
    change re-enriches everything once."""
    # Mode marker keeps a text-only result distinct from an image result for the
    # same lot, so a later with-images run re-enriches rather than reusing it.
    mode = "text" if _text_only() else f"img{MAX_IMAGE_PX}"
    payload = "\x1f".join(
        (
            ENRICHMENT_SCHEMA_VERSION,
            _EnrichmentSettings().model,
            mode,
            item_prompt_text(item),
            *item_image_urls(item),
        )
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def build_content(item: dict) -> list:
    """The user-turn content: the first few photos (http(s) URLs) plus the lot's
    identifying text."""
    content = [
        {"type": "image", "source": {"type": "url", "url": url}}
        for url in item_image_urls(item)
    ]
    content.append({"type": "text", "text": item_prompt_text(item)})
    return content


def fetch_image_base64(url: str) -> tuple[str, str] | None:
    """Download an image and return ``(media_type, base64_data)`` as a downscaled
    JPEG, or ``None`` on any failure (caller falls back to text-only). Used by the
    batch path to inline images so Anthropic doesn't fetch the URL itself (which
    would hit the org's URL Content Fetching rate limit)."""
    if not url.startswith(("http://", "https://")):
        return None
    try:
        import base64
        import io

        import requests
        from PIL import Image

        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        img.thumbnail((MAX_IMAGE_PX, MAX_IMAGE_PX))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return "image/jpeg", base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001 — any fetch/decode failure → text-only
        return None


def build_content_inline(item: dict, images: list[tuple[str, str]]) -> list:
    """User content with the photos inlined as base64 (text-only when none could
    be fetched). The batch counterpart to ``build_content``."""
    content = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }
        for media_type, data in images
    ]
    content.append({"type": "text", "text": item_prompt_text(item)})
    return content


def build_request_params(item: dict, content: list | None = None) -> dict:
    """The Messages API params for one lot. ``content`` defaults to the
    image-by-URL content (synchronous path); the batch path passes inlined-image
    content. Everything else is identical so both transports score the same."""
    return {
        "model": _EnrichmentSettings().model,
        # Room for the v4 fields (arrays + url); output tokens are tiny regardless.
        "max_tokens": 512,
        # Deterministic extraction — we want the same lot to score the same way.
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": content if content is not None else build_content(item),
            }
        ],
        "output_config": {"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    }


def _response_text(content) -> str:
    """The first text block's text from a message's content list, or ""."""
    return next(
        (block.text for block in content if getattr(block, "type", None) == "text"), ""
    )


def _valid_confidence(raw_value) -> str:
    value = str(raw_value or "").strip().lower()
    return value if value in CONFIDENCE_VALUES else ""


def _parse_quantity(raw_value) -> str:
    """Item count as a digit string ("" when indeterminate). Stored as a string
    so the Parquet column stays uniform with the rest of the enrichment fields."""
    try:
        n = int(raw_value)
    except (TypeError, ValueError):
        return ""
    return str(n) if n >= 1 else ""


def _parse_enum_list(raw_value, allowed) -> str:
    """JSON-encoded list of the values from ``raw_value`` that are in ``allowed``
    (de-duplicated, order-preserving). "" when empty — kept off-row like an empty
    string so the read-model column is a uniform string (mirrors ``images``)."""
    if not isinstance(raw_value, list):
        return ""
    seen, out = set(), []
    for v in raw_value:
        s = str(v or "").strip().lower()
        if s in allowed and s not in seen:
            seen.add(s)
            out.append(s)
    return json.dumps(out) if out else ""


def _parse_str_list(raw_value, limit) -> str:
    """JSON-encoded list of the first ``limit`` non-empty trimmed strings, or ""."""
    if not isinstance(raw_value, list):
        return ""
    out = [s for v in raw_value if (s := str(v or "").strip())][:limit]
    return json.dumps(out) if out else ""


def _parse_secondary_items(raw_value) -> str:
    """JSON-encoded list of the other identifiable products in a multi-brand lot
    (Option B). Each is {brand, modelOrSku, productType, searchQuery}; ``model_name``
    is accepted as the source key (matching the primary). An entry with no brand,
    model, or search_query is dropped (nothing to comp). Capped at
    ``MAX_SECONDARY_ITEMS``. "" when none, mirroring the other list fields."""
    if not isinstance(raw_value, list):
        return ""
    out = []
    for entry in raw_value:
        if not isinstance(entry, dict):
            continue
        item = {
            "brand": str(entry.get("brand") or "").strip(),
            "modelOrSku": str(
                entry.get("model_name") or entry.get("model_or_sku") or ""
            ).strip(),
            "productType": str(entry.get("product_type") or "").strip(),
            "searchQuery": str(entry.get("search_query") or "").strip(),
        }
        if item["brand"] or item["modelOrSku"] or item["searchQuery"]:
            out.append(item)
        if len(out) >= MAX_SECONDARY_ITEMS:
            break
    return json.dumps(out) if out else ""


def _parse_details(raw_category, raw_details, confidence: str) -> tuple[str, str]:
    """Validate the v6 category-aware detail bag → ``(detailCategory, detailsJson)``.

    Returns ``("", "")`` unless the category is a known value, ``details`` is a
    dict, and ``confidence`` is medium/high (only confident detail is saved — the
    display bar). The stored bag is pruned to the category's keys with empty
    values dropped, so a furniture row is ``{"style": …}`` and an art row is
    ``{"artist": …}`` rather than the full schema superset."""
    category = str(raw_category or "").strip().lower()
    if category not in DETAIL_CATEGORY_VALUES or confidence not in ("medium", "high"):
        return "", ""
    keys = DETAIL_KEYS_BY_CATEGORY.get(category, ())
    if not keys or not isinstance(raw_details, dict):
        return "", ""
    bag = {}
    for key in keys:
        value = str(raw_details.get(key) or "").strip()
        if value:
            bag[key] = value
    if not bag:
        return "", ""
    return category, json.dumps(bag)


def parse_enrichment(raw: dict) -> dict:
    """Map the model's JSON to the camelCase fields, validating the closed sets.
    An invalid condition/confidence or a non-http product_url is dropped to ""
    rather than trusted. Brand and model are scored separately; the overall
    ``enrichmentConfidence`` is their max (a confident brand alone clears the bar,
    so brand-only lots still get surfaced — falls back to a legacy single
    ``confidence`` for older cached rows)."""
    out = _empty_enrichment()
    if not isinstance(raw, dict):
        return out
    condition = str(raw.get("condition") or "").strip().lower()
    product_url = str(raw.get("product_url") or "").strip()
    legacy = _valid_confidence(raw.get("confidence"))
    brand_conf = _valid_confidence(raw.get("brand_confidence")) or legacy
    model_conf = _valid_confidence(raw.get("model_confidence")) or legacy
    out["brand"] = str(raw.get("brand") or "").strip()
    # `model_name` (v3) supersedes the old `model_or_sku`; accept either so older
    # cached payloads still parse. Stored under modelOrSku for read-model continuity.
    out["modelOrSku"] = str(
        raw.get("model_name") or raw.get("model_or_sku") or ""
    ).strip()
    out["productType"] = str(raw.get("product_type") or "").strip()
    out["searchQuery"] = str(raw.get("search_query") or "").strip()
    out["quantity"] = _parse_quantity(raw.get("quantity"))
    out["isMixedLot"] = "true" if bool(raw.get("is_mixed_lot")) else "false"
    out["conditionFlags"] = _parse_enum_list(
        raw.get("condition_flags"), CONDITION_FLAG_VALUES
    )
    out["keyAttributes"] = _parse_str_list(
        raw.get("key_attributes"), MAX_KEY_ATTRIBUTES
    )
    out["secondaryItems"] = _parse_secondary_items(raw.get("secondary_items"))
    out["notes"] = str(raw.get("notes") or "").strip()
    out["condition"] = condition if condition in CONDITION_VALUES else ""
    out["productUrl"] = (
        product_url if product_url.startswith(("http://", "https://")) else ""
    )
    out["brandConfidence"] = brand_conf
    out["modelConfidence"] = model_conf
    # Category-aware detail (v6): only kept at medium/high, which clears the bag +
    # category to "" when low — so the saved detail is always display-confident.
    detail_conf = _valid_confidence(raw.get("detail_confidence"))
    out["detailCategory"], out["details"] = _parse_details(
        raw.get("detail_category"), raw.get("details"), detail_conf
    )
    out["detailConfidence"] = detail_conf if out["detailCategory"] else ""
    # The overall bar is the max of brand/model/detail — a confident style or
    # artist surfaces an unbranded antique just as a confident brand surfaces a tool.
    out["enrichmentConfidence"] = max(
        (brand_conf, model_conf, out["detailConfidence"]),
        key=lambda c: _CONFIDENCE_RANK[c],
    )
    return out


def _finalize_result(item: dict, result: dict) -> dict:
    """Stamp provenance + input fingerprint onto a parsed enrichment. Shared by
    the synchronous and batch paths so both cache identically."""
    # Stamp provenance only on lots that were actually identified.
    if result.get("enrichmentConfidence"):
        result["enrichmentModel"] = _EnrichmentSettings().model
    # Schema version is stamped on every processed lot (identified or not) so the
    # Supabase mirror can record which prompt/schema produced the row — queryable
    # without recomputing the fingerprint.
    result["enrichmentSchemaVersion"] = ENRICHMENT_SCHEMA_VERSION
    # Fingerprint the inputs so a later scrape can reuse this result unchanged.
    # Stamped on every processed lot (identified or not) so even empty results
    # are cached — otherwise the generic-junk majority would re-call every run.
    result["enrichmentInputHash"] = enrichment_fingerprint(item)
    return result


def enrich_item(client, item: dict) -> dict:
    """Call Claude for one lot and return its parsed enrichment. Raises on API
    error — the caller isolates per-lot failures."""
    _limiter.acquire()
    response = client.messages.create(**build_request_params(item))
    result = _finalize_result(
        item, parse_enrichment(json.loads(_response_text(response.content)))
    )
    # Stash usage for the run's cost ledger. These private keys are not in
    # ENRICHMENT_FIELDS, so apply_enrichment never copies them onto the item.
    usage = getattr(response, "usage", None)
    if usage is not None:
        in_tok = getattr(usage, "input_tokens", 0)
        out_tok = getattr(usage, "output_tokens", 0)
        result["_input_tokens"] = in_tok if isinstance(in_tok, int) else 0
        result["_output_tokens"] = out_tok if isinstance(out_tok, int) else 0
    return result


def apply_enrichment(item: dict, enrichment: dict) -> None:
    for field in ENRICHMENT_FIELDS:
        item[field] = enrichment.get(field, "")


def enrichment_summary(rows: list[dict]) -> dict:
    """Identification counts for a set of lots. ``identified`` is the medium/high
    bar that actually reaches Supabase + the UI — the real success metric, as
    opposed to merely *processed* (which the per-run ``enriched N/M`` line counts,
    since even an unidentifiable lot gets a bookkeeping fingerprint)."""
    from collections import Counter

    conf = Counter()
    brand = model = 0
    for row in rows:
        c = str(row.get("enrichmentConfidence") or "").strip().lower()
        conf[c if c in CONFIDENCE_VALUES else "none"] += 1
        if str(row.get("brand") or "").strip():
            brand += 1
        if str(row.get("modelOrSku") or "").strip():
            model += 1
    return {
        "total": len(rows),
        "identified": conf["high"] + conf["medium"],
        "high": conf["high"],
        "medium": conf["medium"],
        "low": conf["low"],
        "none": conf["none"],
        "brand": brand,
        "model": model,
    }


def format_enrichment_summary(label: str, summary: dict) -> str:
    total = summary["total"]
    pct = (100 * summary["identified"] / total) if total else 0
    return (
        f"  {label}: {summary['identified']}/{total} identified ({pct:.0f}%) "
        f"[high={summary['high']} medium={summary['medium']} low={summary['low']} none={summary['none']}] "
        f"brand={summary['brand']} model={summary['model']}"
    )


def load_prior_enrichment(ndjson_path: Path) -> dict:
    """Map lot id → its previous read-model row from a sidecar, for incremental
    reuse. Empty dict when the sidecar is absent (first scrape of an auction)."""
    prior_by_id: dict = {}
    if not ndjson_path.exists():
        return prior_by_id
    for line in ndjson_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("id") is not None:
            prior_by_id[row["id"]] = row
    return prior_by_id


def reuse_prior_enrichment(item: dict, prior_by_id: dict | None) -> dict | None:
    """Return a prior lot's enrichment if it was produced from identical inputs.

    A lot whose fingerprint matches the prior read model's row gets the same API
    answer, so we copy it forward and skip the call. ``None`` means no reusable
    prior — the lot must be (re-)enriched."""
    if not prior_by_id:
        return None
    prior = prior_by_id.get(item.get("id"))
    if not prior:
        return None
    prior_hash = str(prior.get("enrichmentInputHash") or "")
    if prior_hash and prior_hash == enrichment_fingerprint(item):
        return {field: prior.get(field, "") for field in ENRICHMENT_FIELDS}
    return None


def _resolve_client(client):
    """Return a usable client, or None when enrichment is a no-op. ``client``
    passed explicitly (backfill CLI, tests) bypasses the env gate."""
    if client is not None:
        return client
    if not is_enrichment_enabled():
        return None
    return _make_client()


def _partition_for_enrichment(
    items: list[dict], prior_by_id: dict | None
) -> tuple[list[dict], int]:
    """Seed every lot with empty enrichment fields (consistent Parquet schema),
    then split into the lots that must hit the API vs. those reused unchanged
    from ``prior_by_id``. Returns ``(to_enrich, reused_count)``."""
    for item in items:
        for field in ENRICHMENT_FIELDS:
            item.setdefault(field, "")

    to_enrich, reused = [], 0
    for item in items:
        cached = reuse_prior_enrichment(item, prior_by_id)
        if cached is None:
            to_enrich.append(item)
        else:
            apply_enrichment(item, cached)
            reused += 1
    return to_enrich, reused


def enrich_items(
    items: list[dict], client=None, prior_by_id: dict | None = None
) -> int:
    """Enrich every lot in place; return the count that got any field populated.

    A no-op (returns 0) unless enrichment is enabled and a client can be built —
    so callers can invoke it unconditionally after a scrape. Pass ``client``
    explicitly (backfill CLI, tests) to bypass the env gate. Per-lot failures are
    logged and skipped so one bad lot never aborts the run; every item is seeded
    with empty fields first so the Parquet schema stays consistent across rows.

    ``prior_by_id`` maps lot id → its previous read-model row; any lot whose
    enrichment inputs are unchanged (matching ``enrichmentInputHash``) reuses
    that row instead of paying for an identical API call, so steady-state scrapes
    only spend on new or changed lots.

    This is the **synchronous** path — one throttled request per lot — suited to
    a live scrape where latency matters. For a large historical backfill, prefer
    ``enrich_items_batch`` (Message Batches API: 50% cheaper, no rate-limit
    thrashing, async)."""
    if not items:
        return 0
    client = _resolve_client(client)
    if client is None:
        return 0

    cfg = _EnrichmentSettings()
    # Rebuild the rate limiter for this run so env changes take effect.
    global _limiter
    _limiter = _RateLimiter(cfg.rpm)

    # Reuse unchanged lots up front; only the rest hit the API.
    to_enrich, reused = _partition_for_enrichment(items, prior_by_id)

    enriched = 0
    input_tokens = 0
    output_tokens = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=cfg.workers) as pool:
        futures = {pool.submit(enrich_item, client, item): item for item in to_enrich}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 — isolate per-lot failures
                print(
                    f"  enrich: skipped lot {item.get('id')} ({exc})", file=sys.stderr
                )
                continue
            input_tokens += int(result.pop("_input_tokens", 0) or 0)
            output_tokens += int(result.pop("_output_tokens", 0) or 0)
            apply_enrichment(item, result)
            if any(result.get(field) for field in ENRICHMENT_FIELDS):
                enriched += 1

    # Sync path is the standard (non-batch) per-token rate — no 50% discount.
    est_cost_usd = round(
        input_tokens / 1e6 * PRICE_IN_PER_MTOK
        + output_tokens / 1e6 * PRICE_OUT_PER_MTOK,
        4,
    )
    reused_note = f" (reused {reused} unchanged)" if reused else ""
    print(f"  enriched {enriched}/{len(to_enrich)} lots via {cfg.model}{reused_note}")
    if to_enrich:
        print(
            f"  enrich: sync cost ~${est_cost_usd:.4f} "
            f"({input_tokens} in + {output_tokens} out tok, standard rate, {cfg.model})"
        )
    _telemetry_capture(
        "enrich_sync_completed",
        {
            "lots": len(to_enrich),
            "enriched": enriched,
            "reused": reused,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "est_cost_usd": est_cost_usd,
            "model": cfg.model,
        },
    )
    _record_enrich_run(
        {
            "mode": "sync",
            "model": cfg.model,
            "schema_version": ENRICHMENT_SCHEMA_VERSION,
            "auction_safe_id": _chunk_safe_id(to_enrich),
            "lots_submitted": len(to_enrich),
            "lots_enriched": enriched,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "est_cost_usd": est_cost_usd,
        }
    )
    return enriched


def _wait_for_batch(
    client, batch_id: str, poll_interval: float, max_wait: float
) -> str:
    """Poll a Message Batch until it ends; return its final processing status
    (``"ended"`` on success, or the last-seen status / ``"timed_out"`` if the
    deadline passes first)."""
    deadline = time.monotonic() + max_wait
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        status = getattr(batch, "processing_status", None)
        if status == "ended":
            return "ended"
        if time.monotonic() >= deadline:
            return status or "timed_out"
        counts = getattr(batch, "request_counts", None)
        if counts is not None:
            print(
                f"    batch {batch_id}: {status} "
                f"(processing={getattr(counts, 'processing', '?')}, "
                f"succeeded={getattr(counts, 'succeeded', '?')}, "
                f"errored={getattr(counts, 'errored', '?')})"
            )
        time.sleep(poll_interval)


def _fetch_chunk_images(chunk: list[dict]) -> dict[int, list[tuple[str, str]]]:
    """Concurrently download + downscale each lot's first few images (#152),
    keyed by ``id(item)`` → list of ``(media_type, base64)`` in original order.
    Failed/absent images are dropped; a lot with none falls back to text-only."""
    # One fetch task per (lot, url); preserve per-lot order when reassembling.
    order: dict[int, list[str]] = {id(item): item_image_urls(item) for item in chunk}
    fetched: dict[tuple[int, str], tuple[str, str] | None] = {}
    tasks = {(key, url) for key, urls in order.items() for url in urls}
    with concurrent.futures.ThreadPoolExecutor(max_workers=IMAGE_FETCH_WORKERS) as pool:
        futures = {
            pool.submit(fetch_image_base64, url): (key, url) for key, url in tasks
        }
        for future in concurrent.futures.as_completed(futures):
            fetched[futures[future]] = future.result()
    images: dict[int, list[tuple[str, str]]] = {}
    for key, urls in order.items():
        images[key] = [
            img for url in urls if (img := fetched.get((key, url))) is not None
        ]
    return images


def _build_batch_requests(
    chunk: list[dict], inline_images: bool
) -> tuple[list[dict], dict[str, dict]]:
    """Build the batch requests for ``chunk`` and the ``custom_id`` → item map.

    Index-based ``custom_id`` (``lot-N``) so the lot's own id never has to satisfy
    the custom_id charset/length rules. When ``inline_images`` the photos are
    downloaded + downscaled and inlined as base64 (no server-side URL fetch)."""
    images = _fetch_chunk_images(chunk) if inline_images else {}
    by_custom_id: dict[str, dict] = {}
    requests = []
    for i, item in enumerate(chunk):
        custom_id = f"lot-{i}"
        by_custom_id[custom_id] = item
        content = (
            build_content_inline(item, images.get(id(item), []))
            if inline_images
            else None
        )
        requests.append(
            {
                "custom_id": custom_id,
                "params": build_request_params(item, content=content),
            }
        )
    return requests, by_custom_id


def _run_one_batch(
    client,
    chunk: list[dict],
    poll_interval: float,
    max_wait: float,
    inline_images: bool,
) -> int:
    """Submit one Message Batch for ``chunk`` and apply the results in place.
    Returns the count of lots that got any field populated."""
    model = _EnrichmentSettings().model
    requests, by_custom_id = _build_batch_requests(chunk, inline_images)
    batch = client.messages.batches.create(requests=requests)
    batch_id = getattr(batch, "id", None) or batch["id"]
    print(f"  enrich: submitted batch {batch_id} ({len(requests)} lots); polling…")
    _telemetry_capture(
        "enrich_batch_submitted",
        {
            "batch_id": batch_id,
            "lots": len(requests),
            "transport": "inline" if inline_images else "url",
            "model": model,
        },
    )

    status = _wait_for_batch(client, batch_id, poll_interval, max_wait)
    if status != "ended":
        print(
            f"  enrich: batch {batch_id} did not finish (status={status}); skipping",
            file=sys.stderr,
        )
        _telemetry_capture(
            "enrich_batch_failed",
            {
                "batch_id": batch_id,
                "lots": len(requests),
                "status": status,
                "model": model,
            },
        )
        return 0

    enriched = 0
    errored = 0
    input_tokens = 0
    output_tokens = 0
    for result in client.messages.batches.results(batch_id):
        custom_id = getattr(result, "custom_id", None)
        item = by_custom_id.get(custom_id) if isinstance(custom_id, str) else None
        if item is None:
            continue
        outcome = result.result
        outcome_type = getattr(outcome, "type", None)
        if outcome_type != "succeeded":
            # errored / expired / canceled — leave the seeded empty fields and no
            # fingerprint, so the lot is retried on the next backfill (like sync).
            errored += 1
            print(
                f"  enrich: batch lot {item.get('id')} {outcome_type}", file=sys.stderr
            )
            continue
        usage = getattr(getattr(outcome, "message", None), "usage", None)
        if usage is not None:
            in_tok = getattr(usage, "input_tokens", 0)
            out_tok = getattr(usage, "output_tokens", 0)
            input_tokens += in_tok if isinstance(in_tok, int) else 0
            output_tokens += out_tok if isinstance(out_tok, int) else 0
        try:
            applied = _finalize_result(
                item,
                parse_enrichment(json.loads(_response_text(outcome.message.content))),
            )
        except Exception as exc:  # noqa: BLE001 — isolate per-lot failures
            print(
                f"  enrich: batch parse failed for lot {item.get('id')} ({exc})",
                file=sys.stderr,
            )
            continue
        apply_enrichment(item, applied)
        if any(applied.get(field) for field in ENRICHMENT_FIELDS):
            enriched += 1
    # Batch pricing is 50% of the per-token list rate.
    est_cost_usd = round(
        (
            input_tokens / 1e6 * PRICE_IN_PER_MTOK
            + output_tokens / 1e6 * PRICE_OUT_PER_MTOK
        )
        * 0.5,
        4,
    )
    print(
        f"  enrich: batch {batch_id} cost ~${est_cost_usd:.4f} "
        f"({input_tokens} in + {output_tokens} out tok, batch 50%-off rate, {model})"
    )
    _telemetry_capture(
        "enrich_batch_completed",
        {
            "batch_id": batch_id,
            "lots": len(requests),
            "succeeded": enriched,
            "errored": errored,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "est_cost_usd": est_cost_usd,
            "model": model,
        },
    )
    _record_enrich_run(
        {
            "mode": "batch",
            "model": model,
            "schema_version": ENRICHMENT_SCHEMA_VERSION,
            "auction_safe_id": _chunk_safe_id(chunk),
            "lots_submitted": len(requests),
            "lots_enriched": enriched,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "est_cost_usd": est_cost_usd,
            "raw": {"batch_id": batch_id, "errored": errored},
        }
    )
    return enriched


def enrich_items_batch(
    items: list[dict],
    client=None,
    prior_by_id: dict | None = None,
    poll_interval: float = BATCH_POLL_INTERVAL,
    max_wait: float = BATCH_MAX_WAIT,
    inline_images: bool = True,
) -> int:
    """Enrich every lot in place via the **Message Batches API**; return the count
    that got any field populated.

    Same gating, seeding, and unchanged-lot reuse as ``enrich_items`` — the
    difference is transport: lots that need the API are submitted as async
    batches at 50% of the per-token cost. With ``inline_images`` (the default)
    each photo is downloaded + downscaled and inlined as base64, so Anthropic
    never fetches the URL itself — that avoids the org's URL Content Fetching
    rate limit (~100 RPM), which a batch of URL images would otherwise blow
    through. Inline batches are chunked by both ``GOONERS_ENRICHMENT_BATCH_INLINE_SIZE`` and
    ``GOONERS_ENRICHMENT_BATCH_MAX_BYTES`` (payload budget under the 256 MB hard limit);
    URL batches chunk by ``GOONERS_ENRICHMENT_BATCH_SIZE`` only.

    Use this for a large historical backfill (needs ``requests`` + ``pillow`` for
    image inlining); use ``enrich_items`` for a live scrape (a batch can take up
    to 24h to finish). A no-op (returns 0) unless enrichment is enabled and a
    client can be built."""
    if not items:
        return 0
    client = _resolve_client(client)
    if client is None:
        return 0

    cfg = _EnrichmentSettings()
    to_enrich, reused = _partition_for_enrichment(items, prior_by_id)
    if not to_enrich:
        if reused:
            print(
                f"  enriched 0/0 lots via {cfg.model} (batch) (reused {reused} unchanged)"
            )
        return 0

    max_count = cfg.batch_inline_size if inline_images else cfg.batch_max_requests
    enriched = 0
    for chunk in _chunk_for_batch(
        to_enrich, max_count, inline_images, cfg.max_images, cfg.batch_max_bytes
    ):
        enriched += _run_one_batch(
            client, chunk, poll_interval, max_wait, inline_images
        )

    reused_note = f" (reused {reused} unchanged)" if reused else ""
    print(
        f"  enriched {enriched}/{len(to_enrich)} lots via {cfg.model} (batch){reused_note}"
    )
    return enriched


def _chunk_for_batch(
    to_enrich: list[dict],
    max_count: int,
    inline_images: bool,
    max_images: int,
    max_bytes: int,
):
    """Yield chunks bounded by request count and, for inline batches, a payload
    byte budget (a rough estimate from the lot's text + image bytes, so a chunk
    of large photos still lands under the 256 MB hard limit)."""
    chunk: list[dict] = []
    chunk_bytes = 0
    for item in to_enrich:
        # Rough per-request size: prompt text + (for inline) the on-disk image.
        est = len(item_prompt_text(item).encode("utf-8")) + 2048
        if inline_images:
            # base64 of the downscaled JPEGs; cap per-photo so one big source
            # image doesn't over-inflate the budget (we downscale before send).
            est += min(_estimated_image_bytes(item), 400 * 1024 * max_images)
        if chunk and (
            len(chunk) >= max_count
            or (inline_images and chunk_bytes + est > max_bytes)
        ):
            yield chunk
            chunk, chunk_bytes = [], 0
        chunk.append(item)
        chunk_bytes += est
    if chunk:
        yield chunk


def _estimated_image_bytes(item: dict) -> int:
    """A cheap upper-bound estimate of a lot's inlined images' base64 size for
    chunk budgeting — we can't know the real size without fetching, so assume a
    downscaled JPEG near the per-image cap, times the number of photos."""
    return 300 * 1024 * len(item_image_urls(item))


def _write_rows(items_dir, safe_id: str, rows: list[dict]) -> None:
    """Rewrite one auction's NDJSON + Parquet sidecars (mirroring recategorize.py)."""
    (items_dir / f"{safe_id}.ndjson").write_text(
        "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n",
        encoding="utf-8",
    )
    import pyarrow as pa
    import pyarrow.parquet as pq

    for row in rows:
        if isinstance(row.get("images"), list):
            row["images"] = json.dumps(row["images"])
    pq.write_table(
        pa.Table.from_pylist(rows),
        items_dir / f"{safe_id}.parquet",
        compression="snappy",
    )


def _backfill_dirs():
    """The read-model item dirs, active first then archive. The archive (the
    sold-price corpus) is the bulk of a historical backfill, so it must be
    reachable — but importing lazily keeps the module import light."""
    from scrape import ITEMS_DIR

    dirs = [ITEMS_DIR]
    try:
        from rescrape_all import ARCHIVE_ITEMS_DIR

        dirs.append(ARCHIVE_ITEMS_DIR)
    except ImportError:
        pass
    return dirs


def _resolve_backfill_targets(safe_ids: list[str], include_all: bool) -> list[tuple]:
    """Return an ordered list of ``(items_dir, safe_id)`` to backfill.

    ``--all`` globs every auction across active + archive (deduped, active
    winning). Named ids are each resolved in the active dir first, then the
    archive — so a historical (archived) auction can be backfilled by id too."""
    dirs = [d for d in _backfill_dirs() if d.exists()]
    if include_all:
        targets, seen = [], set()
        for items_dir in dirs:
            for path in sorted(items_dir.glob("*.ndjson")):
                if path.stem not in seen:
                    seen.add(path.stem)
                    targets.append((items_dir, path.stem))
        return targets

    targets = []
    for safe_id in safe_ids:
        for items_dir in dirs:
            if (items_dir / f"{safe_id}.ndjson").exists():
                targets.append((items_dir, safe_id))
                break
        else:
            print(
                f"skip {safe_id}: no NDJSON sidecar (active or archive)",
                file=sys.stderr,
            )
    return targets


def _backfill(
    safe_ids: list[str], use_batch: bool = False, include_all: bool = False
) -> int:
    """Enrich already-scraped auctions, rewriting NDJSON + Parquet, then mirror
    the identified lots into Supabase.

    Spans the **active and archive** read models — ``--all`` covers every auction
    in both; named ids resolve in either. ``use_batch`` uses the Message Batches
    API (50% cost); otherwise the synchronous path.

    Processing is **per auction, write-and-mirror as it goes** — each auction is
    enriched, its sidecars rewritten, and its identified lots mirrored to Supabase
    before the next auction starts. So an interrupted run keeps every auction it
    finished, and a rerun **resumes**: each auction's already-enriched lots are
    reused via their input hash (``prior_by_id`` built from the on-disk rows) and
    are not re-billed. The Supabase mirror is the resilient ``maybe_export_enrichment``
    hook (a no-op without ``SUPABASE_SECRET_KEY``; warns rather than raising)."""
    if not is_enrichment_enabled():
        print(
            "Enrichment disabled. Set GOONERS_ENRICHMENT=1 and ANTHROPIC_API_KEY.",
            file=sys.stderr,
        )
        return 1
    client = _make_client()
    if client is None:
        return 1

    targets = _resolve_backfill_targets(safe_ids, include_all)
    loaded = []  # (items_dir, safe_id, rows)
    for items_dir, safe_id in targets:
        rows = [
            json.loads(line)
            for line in (items_dir / f"{safe_id}.ndjson").read_text().splitlines()
            if line.strip()
        ]
        if rows:
            loaded.append((items_dir, safe_id, rows))

    if not loaded:
        return 0

    from supabase_enrichment import maybe_export_enrichment

    all_rows = []
    for items_dir, safe_id, rows in loaded:
        # The on-disk rows are the prior state: any lot already enriched (carrying
        # an input hash) is reused, so a rerun after an interruption skips the
        # auctions/lots already done instead of re-billing them.
        prior_by_id = {r["id"]: dict(r) for r in rows if r.get("id") is not None}
        if use_batch:
            enrich_items_batch(rows, client=client, prior_by_id=prior_by_id)
        else:
            enrich_items(rows, client=client, prior_by_id=prior_by_id)
        # Persist + mirror this auction before moving on, so progress survives an
        # interrupted run.
        _write_rows(items_dir, safe_id, rows)
        print(f"enriched + rewrote {safe_id} ({len(rows)} lots)")
        print(format_enrichment_summary(safe_id, enrichment_summary(rows)))
        maybe_export_enrichment(rows)
        all_rows.extend(rows)

    # Overall identification rate, so a low-yield run is obvious at a glance (and
    # which auctions dragged it down, from the per-auction lines above).
    print(format_enrichment_summary("TOTAL", enrichment_summary(all_rows)))
    _telemetry_flush()
    return 0


def estimate_enrichment_cost(
    client,
    to_enrich: list[dict],
    *,
    batch: bool = True,
    sample_size: int = ESTIMATE_SAMPLE,
) -> dict:
    """Pre-flight cost estimate for enriching ``to_enrich`` — counts input tokens
    on a spread sample (real content incl. inlined images, via ``count_tokens``)
    and extrapolates to the full set. Output tokens are a small bounded constant
    (the v4 JSON). Prints a one-line summary; never spends on completions."""
    n = len(to_enrich)
    if n == 0 or client is None:
        print("  enrich: cost estimate — 0 lots to enrich ($0.00)")
        return {"lots": 0, "avg_input_tokens": 0, "est_cost_usd": 0.0}
    step = max(1, n // sample_size)
    sample = to_enrich[::step][:sample_size]
    images = _fetch_chunk_images(sample)
    counts = []
    for item in sample:
        try:
            params = build_request_params(
                item, content=build_content_inline(item, images.get(id(item), []))
            )
            ct = client.messages.count_tokens(
                model=params["model"],
                system=params["system"],
                messages=params["messages"],
            )
            counts.append(int(ct.input_tokens))
        except Exception as exc:  # noqa: BLE001 — estimate is best-effort
            print(
                f"  enrich: token count failed for a sample lot ({exc})",
                file=sys.stderr,
            )
    if not counts:
        print(
            "  enrich: cost estimate unavailable (token counting failed)",
            file=sys.stderr,
        )
        return {"lots": n, "avg_input_tokens": 0, "est_cost_usd": 0.0}
    avg_in = sum(counts) / len(counts)
    discount = 0.5 if batch else 1.0
    in_cost = avg_in * n / 1e6 * PRICE_IN_PER_MTOK * discount
    out_cost = ESTIMATE_OUTPUT_TOKENS * n / 1e6 * PRICE_OUT_PER_MTOK * discount
    total = in_cost + out_cost
    rate = "batch (50% off)" if batch else "standard"
    print(
        f"  enrich: cost estimate — {n} lots to enrich, ~{avg_in:.0f} input tok/lot "
        f"(sampled {len(counts)}); ~${total:.2f} at {rate} rate "
        f"(input ${in_cost:.2f} + output ${out_cost:.2f}, {_EnrichmentSettings().model})"
    )
    return {
        "lots": n,
        "avg_input_tokens": round(avg_in),
        "est_cost_usd": round(total, 2),
    }


def _backfill_from_supabase(
    safe_ids: list[str] | None,
    use_batch: bool = False,
    estimate_only: bool = False,
    limit: int | None = None,
) -> int:
    """Enrich lots fetched from the Supabase ``lots`` table (no NDJSON needed).

    Prior enrichment hashes are loaded from ``lot_enrichment`` so unchanged lots
    are reused without re-paying for an API call. Enriched results are upserted
    back to ``lot_enrichment`` via ``maybe_export_enrichment``.
    """
    if not is_enrichment_enabled():
        print(
            "Enrichment disabled. Set GOONERS_ENRICHMENT=1 and ANTHROPIC_API_KEY.",
            file=sys.stderr,
        )
        return 1
    client = _make_client()
    if client is None:
        return 1

    if not secrets.supabase_secret_key():
        print(
            "error: SUPABASE_SECRET_KEY is required for --from-supabase",
            file=sys.stderr,
        )
        return 1

    from supabase_enrichment import (
        load_prior_enrichment_from_supabase,
        maybe_export_enrichment,
    )
    from supabase_lots import fetch_lots_for_auction, list_auction_safe_ids

    if safe_ids:
        # Named IDs: collect (safe_id, archived, rows) for each that resolves.
        work: list[tuple[str, bool, list]] = []
        for sid in safe_ids:
            for archived in (False, True):
                lots = fetch_lots_for_auction(sid, archived=archived)
                if lots:
                    work.append((sid, archived, lots))
        if not work:
            print("No matching auctions found in Supabase lots table.")
            return 0
    else:
        active_ids = list_auction_safe_ids(archived=False)
        archive_ids = list_auction_safe_ids(archived=True)
        work = [(sid, False, []) for sid in active_ids] + [
            (sid, True, []) for sid in archive_ids
        ]

    if not work:
        print("No auctions found in Supabase lots table.")
        return 0

    # Pre-flight: sum the lots that would actually hit the API (reuse-gated),
    # estimate the cost once across the whole corpus, and exit without spending.
    if estimate_only:
        all_to_enrich: list[dict] = []
        for safe_id, archived, prefetched in work:
            rows = (
                prefetched
                if prefetched
                else fetch_lots_for_auction(safe_id, archived=archived)
            )
            if not rows:
                continue
            to_enrich, _reused = _partition_for_enrichment(
                rows, load_prior_enrichment_from_supabase(safe_id)
            )
            all_to_enrich.extend(to_enrich)
        estimate_enrichment_cost(client, all_to_enrich, batch=use_batch)
        return 0

    remaining = limit  # None = no cap; otherwise stop once this many lots enriched
    all_rows = []
    for safe_id, archived, prefetched in work:
        rows = (
            prefetched
            if prefetched
            else fetch_lots_for_auction(safe_id, archived=archived)
        )
        if not rows:
            continue
        if remaining is not None:
            rows = rows[:remaining]  # --limit: validate on a small slice
        prior_by_id = load_prior_enrichment_from_supabase(safe_id)
        if use_batch:
            enrich_items_batch(rows, client=client, prior_by_id=prior_by_id)
        else:
            enrich_items(rows, client=client, prior_by_id=prior_by_id)
        print(f"enriched {safe_id} ({len(rows)} lots, archived={archived})")
        print(format_enrichment_summary(safe_id, enrichment_summary(rows)))
        maybe_export_enrichment(rows)
        all_rows.extend(rows)
        if remaining is not None:
            remaining -= len(rows)
            if remaining <= 0:
                break

    print(format_enrichment_summary("TOTAL", enrichment_summary(all_rows)))
    _telemetry_flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    use_batch = "--batch" in argv
    include_all = "--all" in argv
    from_supabase = "--from-supabase" in argv
    estimate_only = "--estimate-only" in argv
    if "--text-only" in argv:
        os.environ["GOONERS_ENRICHMENT_TEXT_ONLY"] = "1"
    # --enrich [0|1] sets the GOONERS_ENRICHMENT gate in-process so a backfill
    # doesn't require exporting the env var first (running enrich.py *is* the
    # intent to enrich). Bare --enrich means 1; --enrich 0 forces the no-op path.
    # ANTHROPIC_API_KEY is still required (see is_enrichment_enabled). Safe ids are
    # never "0"/"1", so the value is unambiguous to consume.
    if "--enrich" in argv:
        i = argv.index("--enrich")
        if i + 1 < len(argv) and argv[i + 1] in ("0", "1"):
            os.environ["GOONERS_ENRICHMENT"] = argv[i + 1]
            argv = argv[:i] + argv[i + 2 :]
        else:
            os.environ["GOONERS_ENRICHMENT"] = "1"
            argv = argv[:i] + argv[i + 1 :]
    # --limit N caps how many lots are enriched (a small validation slice).
    limit = None
    if "--limit" in argv:
        i = argv.index("--limit")
        if i + 1 < len(argv) and argv[i + 1].isdigit():
            limit = int(argv[i + 1])
            argv = argv[:i] + argv[i + 2 :]
        else:
            print("error: --limit requires a positive integer", file=sys.stderr)
            return 1
    argv = [
        arg
        for arg in argv
        if arg
        not in ("--batch", "--all", "--from-supabase", "--estimate-only", "--text-only")
    ]
    if from_supabase:
        return _backfill_from_supabase(
            argv or None, use_batch=use_batch, estimate_only=estimate_only, limit=limit
        )
    if not argv and not include_all:
        print(__doc__)
        return 1
    return _backfill(argv, use_batch=use_batch, include_all=include_all)


if __name__ == "__main__":
    sys.exit(main())
