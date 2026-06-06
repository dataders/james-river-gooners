#!/usr/bin/env python3
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

# Haiku is plenty for structured extraction and the cheapest option; overridable
# for experiments. Note Haiku 4.5 rejects the `effort` parameter, so we don't
# set one — extraction needs neither effort nor extended thinking.
MODEL = os.environ.get("GOONERS_ENRICHMENT_MODEL", "claude-haiku-4-5")
MAX_WORKERS = int(os.environ.get("GOONERS_ENRICHMENT_WORKERS", "8"))
# Concurrent workers blow through a low per-minute org rate limit (e.g. the
# 50 RPM entry tier), so lean on the SDK's built-in 429 handling: it honors the
# `retry-after` header and backs off. A generous retry count lets a lot ride out
# the rate-limit window instead of being dropped. Overridable for higher tiers.
MAX_RETRIES = int(os.environ.get("GOONERS_ENRICHMENT_MAX_RETRIES", "8"))
# Proactively cap the request rate so the worker pool doesn't thrash the org's
# per-minute limit. Relying on the SDK's reactive 429 backoff alone meant every
# worker fired immediately, drew a 429, then slept on `retry-after` — thousands
# of wasted round-trips that dragged a full enrichment past its CI step budget.
# Spacing calls just under the limit (default 45 RPM, below the 50 RPM entry
# tier) makes the run as fast as the limit allows and all but eliminates 429s.
# Set to 0 to disable client-side throttling (e.g. on a higher tier).
ENRICHMENT_RPM = float(os.environ.get("GOONERS_ENRICHMENT_RPM", "45"))

# Message Batches API knobs (the backfill path — `enrich_items_batch`). Batches
# run async at 50% cost with no per-minute *message* rate limit. But an image
# sent by URL is fetched server-side, and URL Content Fetching has its own
# org-wide limit (~100 RPM) that batches do NOT lift — a large batch of URL
# images blows through it and nearly every request returns rate_limit_error. So
# the batch path **inlines images as base64** (we download + downscale them
# ourselves): no server-side fetch, no URL-fetch limit. The tradeoff is request
# size, so inline batches are chunked by both count and a byte budget.
BATCH_MAX_REQUESTS = int(os.environ.get("GOONERS_ENRICHMENT_BATCH_SIZE", "10000"))
# Inlined images make each request far larger, so inline batches cap at a lower
# count and a payload budget well under the 256 MB hard limit.
BATCH_INLINE_MAX_REQUESTS = int(os.environ.get("GOONERS_ENRICHMENT_BATCH_INLINE_SIZE", "2000"))
BATCH_MAX_BYTES = int(os.environ.get("GOONERS_ENRICHMENT_BATCH_MAX_BYTES", str(180 * 1024 * 1024)))
BATCH_POLL_INTERVAL = float(os.environ.get("GOONERS_ENRICHMENT_BATCH_POLL", "30"))
BATCH_MAX_WAIT = float(os.environ.get("GOONERS_ENRICHMENT_BATCH_MAX_WAIT", str(24 * 3600)))
# Downscale inlined images to keep the batch payload small — a brand/model is
# identifiable well below full resolution. Fetched concurrently.
MAX_IMAGE_PX = int(os.environ.get("GOONERS_ENRICHMENT_MAX_IMAGE_PX", "512"))
IMAGE_FETCH_WORKERS = int(os.environ.get("GOONERS_ENRICHMENT_IMAGE_WORKERS", "16"))

# Fields written onto each item, camelCase to match the rest of the read model
# (lotNumber, currentBid, rawCategory, …). `enrichmentModel` records which model
# produced the row (provenance for the Supabase API / future re-runs).
# `enrichmentInputHash` fingerprints the inputs that produced the row (model +
# text + first photo) so a later scrape can reuse an unchanged lot's enrichment
# instead of paying for an identical API call (see `enrich_items`).
ENRICHMENT_FIELDS = (
    "brand", "modelOrSku", "condition", "productUrl",
    "enrichmentConfidence", "enrichmentModel", "enrichmentInputHash",
)
CONDITION_VALUES = ("new", "open box", "used", "for parts", "unknown")
CONFIDENCE_VALUES = ("low", "medium", "high")

# Structured-output schema (json_schema). Haiku 4.5 supports structured outputs;
# enums keep condition/confidence on the closed value sets above. Every field is
# required and additionalProperties is false, so the response is always parseable.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "brand": {"type": "string"},
        "model_or_sku": {"type": "string"},
        "condition": {"type": "string", "enum": list(CONDITION_VALUES)},
        "product_url": {"type": "string"},
        "confidence": {"type": "string", "enum": list(CONFIDENCE_VALUES)},
    },
    "required": ["brand", "model_or_sku", "condition", "product_url", "confidence"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = (
    "You identify consumer products from auction-lot listings so they can be "
    "matched against eBay sold listings and shown to resale buyers. For each "
    "lot you are given its text and (usually) one photo. Extract:\n"
    "- brand: the manufacturer or brand name (e.g. \"DeWalt\", \"KitchenAid\"). "
    "Empty string if there is no identifiable brand.\n"
    "- model_or_sku: the specific model name or number / SKU (e.g. \"DCD771\", "
    "\"Artisan KSM150\"). Empty string if not identifiable. This is the most "
    "valuable field — a brand+model pair becomes the exact search query.\n"
    "- condition: one of new, open box, used, for parts, unknown.\n"
    "- product_url: a canonical manufacturer or major-retailer product page URL "
    "ONLY if you are certain it is real. A hallucinated URL is worse than none, "
    "so when in any doubt return an empty string.\n"
    "- confidence: high only when the brand and model are clearly identifiable; "
    "medium when you are reasonably sure; low for generic, mixed, or ambiguous "
    "lots (e.g. \"box of assorted hardware\", \"Lot - 207\").\n"
    "Never guess. If a field is not supported by the text or photo, return an "
    "empty string and lower your confidence accordingly."
)


def is_enrichment_enabled() -> bool:
    """True only when the user opted in AND a key is present. The opt-in keeps
    enrichment off by default (no surprise API spend on every scrape)."""
    return os.environ.get("GOONERS_ENRICHMENT") == "1" and bool(os.environ.get("ANTHROPIC_API_KEY"))


def _empty_enrichment() -> dict:
    return {field: "" for field in ENRICHMENT_FIELDS}


def _make_client():
    """Construct an Anthropic client, or None if the SDK isn't installed. Import
    is local so importing this module never requires the `anthropic` package."""
    try:
        import anthropic
    except ImportError:
        print("  enrich: anthropic SDK not installed; skipping enrichment", file=sys.stderr)
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


_limiter = _RateLimiter(ENRICHMENT_RPM)


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


def first_image_url(item: dict) -> str:
    """The first http(s) photo URL, or "" — the only image enrichment reads."""
    images = item_images(item)
    if images:
        first = str(images[0])
        if first.startswith(("http://", "https://")):
            return first
    return ""


def enrichment_fingerprint(item: dict) -> str:
    """Stable hash of everything that feeds an enrichment call: the model, the
    lot's identifying text, and its first photo. Two lots (across scrapes) with
    the same fingerprint would get an identical API result, so the prior one can
    be reused. Binding in the model means a model change re-enriches everything."""
    payload = "\x1f".join((MODEL, item_prompt_text(item), first_image_url(item)))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def build_content(item: dict) -> list:
    """The user-turn content: the first photo (when it's an http(s) URL) plus the
    lot's identifying text."""
    content = []
    first = first_image_url(item)
    if first:
        content.append({"type": "image", "source": {"type": "url", "url": first}})
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


def build_content_inline(item: dict, image: tuple[str, str] | None) -> list:
    """User content with the photo inlined as base64 (or text-only when there's
    no usable image). The batch counterpart to ``build_content``."""
    content = []
    if image is not None:
        media_type, data = image
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })
    content.append({"type": "text", "text": item_prompt_text(item)})
    return content


def build_request_params(item: dict, content: list | None = None) -> dict:
    """The Messages API params for one lot. ``content`` defaults to the
    image-by-URL content (synchronous path); the batch path passes inlined-image
    content. Everything else is identical so both transports score the same."""
    return {
        "model": MODEL,
        "max_tokens": 256,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": content if content is not None else build_content(item)}],
        "output_config": {"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    }


def _response_text(content) -> str:
    """The first text block's text from a message's content list, or ""."""
    return next((block.text for block in content if getattr(block, "type", None) == "text"), "")


def parse_enrichment(raw: dict) -> dict:
    """Map the model's JSON to the camelCase fields, validating the closed sets.
    An invalid condition/confidence or a non-http product_url is dropped to ""
    rather than trusted."""
    out = _empty_enrichment()
    if not isinstance(raw, dict):
        return out
    condition = str(raw.get("condition") or "").strip().lower()
    confidence = str(raw.get("confidence") or "").strip().lower()
    product_url = str(raw.get("product_url") or "").strip()
    out["brand"] = str(raw.get("brand") or "").strip()
    out["modelOrSku"] = str(raw.get("model_or_sku") or "").strip()
    out["condition"] = condition if condition in CONDITION_VALUES else ""
    out["productUrl"] = product_url if product_url.startswith(("http://", "https://")) else ""
    out["enrichmentConfidence"] = confidence if confidence in CONFIDENCE_VALUES else ""
    return out


def _finalize_result(item: dict, result: dict) -> dict:
    """Stamp provenance + input fingerprint onto a parsed enrichment. Shared by
    the synchronous and batch paths so both cache identically."""
    # Stamp provenance only on lots that were actually identified.
    if result.get("enrichmentConfidence"):
        result["enrichmentModel"] = MODEL
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
    return _finalize_result(item, parse_enrichment(json.loads(_response_text(response.content))))


def apply_enrichment(item: dict, enrichment: dict) -> None:
    for field in ENRICHMENT_FIELDS:
        item[field] = enrichment.get(field, "")


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


def _partition_for_enrichment(items: list[dict], prior_by_id: dict | None) -> tuple[list[dict], int]:
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


def enrich_items(items: list[dict], client=None, prior_by_id: dict | None = None) -> int:
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

    # Reuse unchanged lots up front; only the rest hit the API.
    to_enrich, reused = _partition_for_enrichment(items, prior_by_id)

    enriched = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(enrich_item, client, item): item for item in to_enrich}
        for future in concurrent.futures.as_completed(futures):
            item = futures[future]
            try:
                result = future.result()
            except Exception as exc:  # noqa: BLE001 — isolate per-lot failures
                print(f"  enrich: skipped lot {item.get('id')} ({exc})", file=sys.stderr)
                continue
            apply_enrichment(item, result)
            if any(result.get(field) for field in ENRICHMENT_FIELDS):
                enriched += 1

    reused_note = f" (reused {reused} unchanged)" if reused else ""
    print(f"  enriched {enriched}/{len(to_enrich)} lots via {MODEL}{reused_note}")
    return enriched


def _wait_for_batch(client, batch_id: str, poll_interval: float, max_wait: float) -> str:
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


def _fetch_chunk_images(chunk: list[dict]) -> dict[int, tuple[str, str] | None]:
    """Concurrently download + downscale each lot's first image, keyed by
    ``id(item)``. A failed/absent image maps to ``None`` (→ text-only)."""
    targets = {id(item): first_image_url(item) for item in chunk}
    images: dict[int, tuple[str, str] | None] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=IMAGE_FETCH_WORKERS) as pool:
        futures = {pool.submit(fetch_image_base64, url): key for key, url in targets.items() if url}
        for future in concurrent.futures.as_completed(futures):
            images[futures[future]] = future.result()
    return images


def _build_batch_requests(chunk: list[dict], inline_images: bool) -> tuple[list[dict], dict[str, dict]]:
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
        content = build_content_inline(item, images.get(id(item))) if inline_images else None
        requests.append({"custom_id": custom_id, "params": build_request_params(item, content=content)})
    return requests, by_custom_id


def _run_one_batch(client, chunk: list[dict], poll_interval: float, max_wait: float, inline_images: bool) -> int:
    """Submit one Message Batch for ``chunk`` and apply the results in place.
    Returns the count of lots that got any field populated."""
    requests, by_custom_id = _build_batch_requests(chunk, inline_images)
    batch = client.messages.batches.create(requests=requests)
    batch_id = getattr(batch, "id", None) or batch["id"]
    print(f"  enrich: submitted batch {batch_id} ({len(requests)} lots); polling…")

    status = _wait_for_batch(client, batch_id, poll_interval, max_wait)
    if status != "ended":
        print(f"  enrich: batch {batch_id} did not finish (status={status}); skipping", file=sys.stderr)
        return 0

    enriched = 0
    for result in client.messages.batches.results(batch_id):
        item = by_custom_id.get(getattr(result, "custom_id", None))
        if item is None:
            continue
        outcome = result.result
        outcome_type = getattr(outcome, "type", None)
        if outcome_type != "succeeded":
            # errored / expired / canceled — leave the seeded empty fields and no
            # fingerprint, so the lot is retried on the next backfill (like sync).
            print(f"  enrich: batch lot {item.get('id')} {outcome_type}", file=sys.stderr)
            continue
        try:
            applied = _finalize_result(item, parse_enrichment(json.loads(_response_text(outcome.message.content))))
        except Exception as exc:  # noqa: BLE001 — isolate per-lot failures
            print(f"  enrich: batch parse failed for lot {item.get('id')} ({exc})", file=sys.stderr)
            continue
        apply_enrichment(item, applied)
        if any(applied.get(field) for field in ENRICHMENT_FIELDS):
            enriched += 1
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
    through. Inline batches are chunked by both ``BATCH_INLINE_MAX_REQUESTS`` and
    ``BATCH_MAX_BYTES`` (payload budget under the 256 MB hard limit); URL batches
    chunk by ``BATCH_MAX_REQUESTS`` only.

    Use this for a large historical backfill (needs ``requests`` + ``pillow`` for
    image inlining); use ``enrich_items`` for a live scrape (a batch can take up
    to 24h to finish). A no-op (returns 0) unless enrichment is enabled and a
    client can be built."""
    if not items:
        return 0
    client = _resolve_client(client)
    if client is None:
        return 0

    to_enrich, reused = _partition_for_enrichment(items, prior_by_id)
    if not to_enrich:
        if reused:
            print(f"  enriched 0/0 lots via {MODEL} (batch) (reused {reused} unchanged)")
        return 0

    max_count = BATCH_INLINE_MAX_REQUESTS if inline_images else BATCH_MAX_REQUESTS
    enriched = 0
    for chunk in _chunk_for_batch(to_enrich, max_count, inline_images):
        enriched += _run_one_batch(client, chunk, poll_interval, max_wait, inline_images)

    reused_note = f" (reused {reused} unchanged)" if reused else ""
    print(f"  enriched {enriched}/{len(to_enrich)} lots via {MODEL} (batch){reused_note}")
    return enriched


def _chunk_for_batch(to_enrich: list[dict], max_count: int, inline_images: bool):
    """Yield chunks bounded by request count and, for inline batches, a payload
    byte budget (a rough estimate from the lot's text + image bytes, so a chunk
    of large photos still lands under the 256 MB hard limit)."""
    chunk: list[dict] = []
    chunk_bytes = 0
    for item in to_enrich:
        # Rough per-request size: prompt text + (for inline) the on-disk image.
        est = len(item_prompt_text(item).encode("utf-8")) + 2048
        if inline_images:
            # base64 of a downscaled JPEG; cap the estimate so one big source
            # image doesn't over-inflate the budget (we downscale before send).
            est += min(_estimated_image_bytes(item), 400 * 1024)
        if chunk and (len(chunk) >= max_count or (inline_images and chunk_bytes + est > BATCH_MAX_BYTES)):
            yield chunk
            chunk, chunk_bytes = [], 0
        chunk.append(item)
        chunk_bytes += est
    if chunk:
        yield chunk


def _estimated_image_bytes(item: dict) -> int:
    """A cheap upper-bound estimate of an inlined image's base64 size for chunk
    budgeting — we can't know the real size without fetching, so assume a
    downscaled JPEG near the per-image cap."""
    return 300 * 1024 if first_image_url(item) else 0


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
    pq.write_table(pa.Table.from_pylist(rows), items_dir / f"{safe_id}.parquet", compression="snappy")


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
            print(f"skip {safe_id}: no NDJSON sidecar (active or archive)", file=sys.stderr)
    return targets


def _backfill(safe_ids: list[str], use_batch: bool = False, include_all: bool = False) -> int:
    """Enrich already-scraped auctions, rewriting NDJSON + Parquet, then mirror
    the identified lots into Supabase.

    Spans the **active and archive** read models — ``--all`` covers every auction
    in both; named ids resolve in either. With ``use_batch`` every selected
    auction's lots are enriched in one combined Message Batch (one async
    submission, 50% cost) before any file is rewritten — the efficient path for a
    large historical backfill. Without it, each auction is enriched synchronously
    in turn (the original behavior). After rewriting the local read model (the
    primary deliverable), the enriched lots are mirrored to the Supabase
    ``lot_enrichment`` table via the resilient ``maybe_export_enrichment`` hook
    (a no-op without ``SUPABASE_SECRET_KEY``; warns rather than raising)."""
    if not is_enrichment_enabled():
        print("Enrichment disabled. Set GOONERS_ENRICHMENT=1 and ANTHROPIC_API_KEY.", file=sys.stderr)
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

    if use_batch:
        # One batch across every selected auction's lots, so a 5,000-lot backfill
        # is a single async submission rather than one synchronous run per auction.
        all_rows = [row for _, _, rows in loaded for row in rows]
        enrich_items_batch(all_rows, client=client)
    else:
        for _, _, rows in loaded:
            enrich_items(rows, client=client)

    for items_dir, safe_id, rows in loaded:
        _write_rows(items_dir, safe_id, rows)
        print(f"enriched + rewrote {safe_id} ({len(rows)} lots)")

    # Mirror the freshly-enriched lots into Supabase (identified lots only).
    # Resilient: a no-op without credentials, warns rather than crashing.
    from supabase_enrichment import maybe_export_enrichment
    maybe_export_enrichment([row for _, _, rows in loaded for row in rows])
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    use_batch = "--batch" in argv
    include_all = "--all" in argv
    argv = [arg for arg in argv if arg not in ("--batch", "--all")]
    if not argv and not include_all:
        print(__doc__)
        return 1
    return _backfill(argv, use_batch=use_batch, include_all=include_all)


if __name__ == "__main__":
    sys.exit(main())
