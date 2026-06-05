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

    python enrich.py <safe_id> [<safe_id> ...]   # backfill the existing read model
"""

import concurrent.futures
import json
import os
import re
import sys
from pathlib import Path

# Haiku is plenty for structured extraction and the cheapest option; overridable
# for experiments. Note Haiku 4.5 rejects the `effort` parameter, so we don't
# set one — extraction needs neither effort nor extended thinking.
MODEL = os.environ.get("GOONERS_ENRICHMENT_MODEL", "claude-haiku-4-5")
MAX_WORKERS = int(os.environ.get("GOONERS_ENRICHMENT_WORKERS", "8"))

# Fields written onto each item, camelCase to match the rest of the read model
# (lotNumber, currentBid, rawCategory, …).
ENRICHMENT_FIELDS = ("brand", "modelOrSku", "condition", "productUrl", "enrichmentConfidence")
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
    return anthropic.Anthropic()


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


def build_content(item: dict) -> list:
    """The user-turn content: the first photo (when it's an http(s) URL) plus the
    lot's identifying text."""
    content = []
    images = item_images(item)
    if images:
        first = str(images[0])
        if first.startswith(("http://", "https://")):
            content.append({"type": "image", "source": {"type": "url", "url": first}})
    content.append({"type": "text", "text": item_prompt_text(item)})
    return content


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


def enrich_item(client, item: dict) -> dict:
    """Call Claude for one lot and return its parsed enrichment. Raises on API
    error — the caller isolates per-lot failures."""
    response = client.messages.create(
        model=MODEL,
        max_tokens=256,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_content(item)}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    text = next((block.text for block in response.content if getattr(block, "type", None) == "text"), "")
    return parse_enrichment(json.loads(text))


def apply_enrichment(item: dict, enrichment: dict) -> None:
    for field in ENRICHMENT_FIELDS:
        item[field] = enrichment.get(field, "")


def enrich_items(items: list[dict], client=None) -> int:
    """Enrich every lot in place; return the count that got any field populated.

    A no-op (returns 0) unless enrichment is enabled and a client can be built —
    so callers can invoke it unconditionally after a scrape. Pass ``client``
    explicitly (backfill CLI, tests) to bypass the env gate. Per-lot failures are
    logged and skipped so one bad lot never aborts the run; every item is seeded
    with empty fields first so the Parquet schema stays consistent across rows."""
    if not items:
        return 0
    if client is None:
        if not is_enrichment_enabled():
            return 0
        client = _make_client()
        if client is None:
            return 0

    for item in items:
        for field in ENRICHMENT_FIELDS:
            item.setdefault(field, "")

    enriched = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(enrich_item, client, item): item for item in items}
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

    print(f"  enriched {enriched}/{len(items)} lots via {MODEL}")
    return enriched


def _backfill(safe_ids: list[str]) -> int:
    """Enrich already-scraped active auctions, rewriting NDJSON + Parquet
    (mirroring recategorize.py)."""
    if not is_enrichment_enabled():
        print("Enrichment disabled. Set GOONERS_ENRICHMENT=1 and ANTHROPIC_API_KEY.", file=sys.stderr)
        return 1
    client = _make_client()
    if client is None:
        return 1

    from scrape import ITEMS_DIR

    for safe_id in safe_ids:
        ndjson_path = ITEMS_DIR / f"{safe_id}.ndjson"
        if not ndjson_path.exists():
            print(f"skip {safe_id}: no NDJSON sidecar", file=sys.stderr)
            continue
        rows = [json.loads(line) for line in ndjson_path.read_text().splitlines() if line.strip()]
        if not rows:
            continue
        enrich_items(rows, client=client)
        ndjson_path.write_text(
            "\n".join(json.dumps(row, separators=(",", ":")) for row in rows) + "\n",
            encoding="utf-8",
        )
        import pyarrow as pa
        import pyarrow.parquet as pq

        for row in rows:
            if isinstance(row.get("images"), list):
                row["images"] = json.dumps(row["images"])
        pq.write_table(pa.Table.from_pylist(rows), ITEMS_DIR / f"{safe_id}.parquet", compression="snappy")
        print(f"enriched + rewrote {safe_id} ({len(rows)} lots)")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print(__doc__)
        return 1
    return _backfill(argv)


if __name__ == "__main__":
    sys.exit(main())
