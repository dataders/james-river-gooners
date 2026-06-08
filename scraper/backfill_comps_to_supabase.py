#!/usr/bin/env python
"""One-time backfill of the static eBay-comps read model into Supabase (#6).

Before Supabase becomes the sole comps source, the comps already accumulated in
``public/data/ebay-comps/*.json`` are copied into ``ebay_comp_snapshots`` so the
cutover doesn't drop coverage. This spends ZERO eBay requests — it only re-inserts
data already fetched — and preserves each record's original ``fetchedAt`` so the
freshness skip and the monthly request budget hand off accurately.

Reverses ``build_public_exports`` (scraper/ebay_comps.py): each match becomes a
snapshot row, and each attempted-but-unmatched item becomes a placeholder row so
the ledger knows it was tried. Run via the "Refresh eBay Comps" workflow with
``backfill_from_json=true`` (it has the Supabase secret).
"""

from decimal import Decimal, InvalidOperation

from ebay_comps import EBAY_COMPS_DIR, load_comp_file
from supabase_comps import append_ebay_comp_snapshots


def _num(value):
    if value in (None, ""):
        return None
    try:
        return float(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return None


def rows_from_comp_file(safe_id: str, payload: dict) -> list[dict]:
    """Reconstruct snapshot rows from one auction's JSON read-model file."""
    rows: list[dict] = []
    items = payload.get("items", {}) or {}
    attempts = payload.get("attempts", {}) or {}

    for item_id, record in items.items():
        base = {
            "auction_safe_id": safe_id,
            "item_id": item_id,
            "status": record.get("status") or "ok",
            "query": record.get("query"),
            "search_url": record.get("searchUrl"),
            "fetched_at": record.get("fetchedAt"),
            "warning": record.get("warning"),
        }
        for match in record.get("matches", []) or []:
            price = match.get("price") or {}
            rows.append({
                **base,
                "ebay_item_id": match.get("ebayItemId"),
                "title": match.get("title"),
                "price_value": _num(price.get("value")),
                "price_currency": price.get("currency") or "USD",
                "shipping_label": match.get("shippingLabel"),
                "sold_date": match.get("soldDate"),
                "sold_date_label": match.get("soldDateLabel"),
                "thumbnail_url": match.get("thumbnailUrl"),
                "item_web_url": match.get("itemWebUrl"),
                "condition": match.get("condition"),
                "source_query": match.get("sourceQuery"),
                "match_confidence": match.get("matchConfidence"),
            })

    # Items attempted but with no surviving match: a placeholder row keeps the
    # ledger from re-fetching them immediately (mirrors the live no-match write).
    for item_id, attempt in attempts.items():
        if item_id in items:
            continue
        rows.append({
            "auction_safe_id": safe_id,
            "item_id": item_id,
            "status": attempt.get("status") or "no_results",
            "fetched_at": attempt.get("fetchedAt"),
        })

    return rows


def main() -> int:
    files = sorted(EBAY_COMPS_DIR.glob("*.json"))
    if not files:
        print(f"No comp files found under {EBAY_COMPS_DIR}; nothing to backfill.")
        return 0

    all_rows: list[dict] = []
    for path in files:
        payload = load_comp_file(path)
        if not payload:
            continue
        all_rows.extend(rows_from_comp_file(path.stem, payload))

    match_rows = sum(1 for r in all_rows if r.get("item_web_url"))
    print(
        f"Backfilling {len(all_rows)} rows ({match_rows} matches) "
        f"from {len(files)} auction files into Supabase…"
    )
    written = append_ebay_comp_snapshots(all_rows)
    print(f"Wrote {written} rows to ebay_comp_snapshots.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
