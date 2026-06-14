from gooners_mcp.schemas import (
    composite_key,
    shape_category_stats,
    shape_ebay_comp,
    shape_lot,
)


def test_composite_key():
    assert composite_key("AbC", 207) == "AbC:207"


def test_shape_lot_merges_enrichment_and_adds_source_url():
    lot = {"auction_safe_id": "A", "item_id": "207", "title": "Lot - 207",
           "current_bid": 42.5, "detail_url": "https://x/207", "images": ["u1", "u2"],
           "category": "Tools", "end_date": "2026-06-20T00:00:00Z"}
    enrich = {"brand": "DeWalt", "model_or_sku": "DCD771", "condition": "used",
              "confidence": "high", "product_url": "https://dewalt/dcd771"}
    out = shape_lot(lot, enrich)
    assert out["composite_key"] == "A:207"
    assert out["source_url"] == "https://x/207"
    assert out["brand"] == "DeWalt"
    assert out["current_bid"] == 42.5
    assert out["image_count"] == 2


def test_shape_lot_without_enrichment():
    lot = {"auction_safe_id": "A", "item_id": "5", "title": "T", "detail_url": "u"}
    out = shape_lot(lot, None)
    assert out["brand"] is None
    assert out["composite_key"] == "A:5"


def test_shape_ebay_comp():
    row = {"title": "DeWalt drill", "price_value": 59.99, "price_currency": "USD",
           "sold_date_label": "Apr 2", "item_web_url": "https://ebay/x",
           "match_confidence": "high"}
    out = shape_ebay_comp(row)
    assert out["price"] == 59.99
    assert out["url"] == "https://ebay/x"


def test_shape_category_stats():
    row = {"category": "Tools", "sold_count": 12, "median_sold": 40,
           "min_sold": 5, "max_sold": 120, "last_sold_at": "2026-06-01T00:00:00Z"}
    out = shape_category_stats(row)
    assert out["median_sold"] == 40
    assert out["sold_count"] == 12
