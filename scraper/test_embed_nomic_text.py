"""Unit tests for the enrichment-aware embed text builder (embed_nomic).

Pure-function tests — no model load, no network. Run:
  uv run --with numpy --with requests --with pytest python -m pytest scraper/test_embed_nomic_text.py -q
"""
import embed_nomic as en


def test_unenriched_text_is_title_description_only():
    item = {"title": "Lot - 12", "description": "Oak dresser, 5 drawers"}
    assert en._document_text(item) == "search_document: Lot - 12 Oak dresser, 5 drawers"


def test_enrichment_fields_fold_into_text():
    item = {
        "title": "Lot - 5",
        "description": "cordless drill in case",
        "brand": "DeWalt",
        "modelOrSku": "DCD771",
        "productType": "cordless drill",
        "searchQuery": "DeWalt DCD771 20V cordless drill",
    }
    text = en._document_text(item)
    assert text.startswith("search_document: Lot - 5 cordless drill in case ")
    assert "DeWalt" in text and "DCD771" in text and "20V" in text


def test_v6_detail_bag_values_fold_in():
    item = {
        "title": "Lot - 88",
        "description": "carved wood chair",
        "details": '{"style": "Queen Anne", "material": "walnut", "form": "wingback armchair"}',
    }
    text = en._document_text(item)
    assert "Queen Anne" in text and "walnut" in text and "wingback armchair" in text


def test_dedup_is_case_insensitive_and_order_preserving():
    # searchQuery repeats brand+model already listed — should appear once.
    item = {
        "title": "t",
        "description": "d",
        "brand": "Sony",
        "modelOrSku": "WH-1000XM4",
        "searchQuery": "sony wh-1000xm4 headphones",
    }
    enrich = en._enrichment_text(item)
    # 'Sony'/'sony' collapse; the searchQuery (distinct phrase) still contributes.
    assert enrich.lower().count("sony") == 1
    assert "headphones" in enrich


def test_empty_enrichment_yields_empty_string():
    assert en._enrichment_text({"title": "t", "description": "d"}) == ""
    # malformed details JSON is ignored, not raised
    assert en._enrichment_text({"details": "{not json"}) == ""


def test_blank_strings_and_none_ignored():
    item = {"brand": "", "modelOrSku": None, "productType": "  ", "searchQuery": "valid phrase"}
    assert en._enrichment_text(item) == "valid phrase"


def test_document_text_falls_back_to_dot_when_all_empty():
    assert en._document_text({}) == "search_document: ."
