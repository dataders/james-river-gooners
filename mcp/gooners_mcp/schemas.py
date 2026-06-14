"""Pure row-shaping helpers: raw PostgREST rows -> compact model-friendly dicts."""
from __future__ import annotations

from typing import Any


def composite_key(auction_safe_id: Any, item_id: Any) -> str:
    return f"{auction_safe_id}:{item_id}"


def shape_lot(lot: dict, enrich: dict | None) -> dict:
    e = enrich or {}
    images = lot.get("images") or []
    return {
        "composite_key": composite_key(lot.get("auction_safe_id"), lot.get("item_id")),
        "auction_safe_id": lot.get("auction_safe_id"),
        "item_id": lot.get("item_id"),
        "lot_number": lot.get("lot_number"),
        "title": lot.get("title"),
        "description": lot.get("description"),
        "category": lot.get("category"),
        "current_bid": lot.get("current_bid"),
        "total_bids": lot.get("total_bids"),
        "unique_bidders": lot.get("unique_bidders"),
        "end_date": lot.get("end_date"),
        "auction_title": lot.get("auction_title"),
        "source": lot.get("source"),
        "source_url": lot.get("detail_url"),
        "image_count": len(images),
        "images": images[:3],
        # enrichment (None when the lot was not identified)
        "brand": e.get("brand"),
        "model_or_sku": e.get("model_or_sku"),
        "condition": e.get("condition"),
        "enrichment_confidence": e.get("confidence"),
        "product_url": e.get("product_url"),
    }


def shape_ebay_comp(row: dict) -> dict:
    return {
        "title": row.get("title"),
        "price": row.get("price_value"),
        "currency": row.get("price_currency"),
        "sold_date": row.get("sold_date_label") or row.get("sold_date"),
        "condition": row.get("condition"),
        "match_confidence": row.get("match_confidence"),
        "url": row.get("item_web_url"),
    }


def shape_cannons_comp(row: dict) -> dict:
    return {
        "rank": row.get("rank"),
        "title": row.get("match_title"),
        "sold_price": row.get("sold_price"),
        "sold_date": row.get("sold_date"),
        "similarity": row.get("similarity"),
        "url": row.get("detail_url"),
    }


def shape_category_stats(row: dict) -> dict:
    return {
        "category": row.get("category"),
        "sold_count": row.get("sold_count"),
        "median_sold": row.get("median_sold"),
        "min_sold": row.get("min_sold"),
        "max_sold": row.get("max_sold"),
        "last_sold_at": row.get("last_sold_at"),
    }
