"""Tests for category normalization in categories.py.

These exercise the public behavior (alias lookup, group mapping, and
description-keyword fallback) rather than the contents of
category_mappings.yml, so they stay valid as the mappings evolve.
"""

from categories import (
    infer_from_description,
    normalize_category,
    normalize_raw_category,
    normalize_raw_with_description,
)


# --- normalize_raw_category --------------------------------------------------

def test_empty_raw_is_other():
    assert normalize_raw_category("") == "Other"
    assert normalize_raw_category(None or "") == "Other"


def test_known_alias_maps_to_canonical():
    # "pottery" is an alias for the canonical "China & Pottery".
    assert normalize_raw_category("pottery") == "China & Pottery"


def test_alias_lookup_is_case_insensitive():
    assert normalize_raw_category("POTTERY") == "China & Pottery"
    assert normalize_raw_category("  Pottery  ") == "China & Pottery"


def test_comma_separated_falls_back_to_first_known_part():
    # Unknown leading token, known trailing token after the comma.
    assert normalize_raw_category("zzz unknown, pottery") == "China & Pottery"


def test_unknown_raw_is_returned_cleaned():
    assert normalize_raw_category("  Widgets,  ") == "Widgets"


# --- normalize_category (group mapping) --------------------------------------

def test_canonical_maps_to_broad_group():
    # "firearm" is a group term, and "Firearms" canonical contains it.
    assert normalize_category("firearm") == "Firearms"


def test_alias_then_group():
    # "pottery" -> "China & Pottery" -> group "China & Glass" (contains "china").
    assert normalize_category("pottery") == "China & Glass"


def test_unmatched_category_without_description_is_other():
    assert normalize_category("completely unknown thing") == "Other"


def test_other_falls_back_to_description_group():
    # No usable raw category, but the description mentions a rifle.
    assert normalize_category("", "Winchester rifle, .30-30 lever action") == "Firearms"


def test_description_fallback_only_when_raw_is_other():
    # A raw category that already maps to a group wins over the description.
    result = normalize_category("firearm", "antique wooden chair")
    assert result == "Firearms"


# --- infer_from_description --------------------------------------------------

def test_infer_from_description_returns_tuple():
    result = infer_from_description("a beautiful gold necklace")
    assert result is not None
    raw_cat, group = result
    assert group == "Jewelry & Watches"


def test_infer_from_empty_description_is_none():
    assert infer_from_description("") is None


def test_infer_from_unmatched_description_is_none():
    assert infer_from_description("xyzzy plugh nothing here") is None


# --- normalize_raw_with_description ------------------------------------------

def test_raw_with_description_prefers_known_raw():
    assert normalize_raw_with_description("pottery", "ignored") == "China & Pottery"


def test_raw_with_description_falls_back_to_description_canonical():
    # Empty raw -> use the canonical raw category inferred from the description.
    result = normalize_raw_with_description("", "a gold necklace")
    assert result == "Jewelry"


def test_raw_with_description_keeps_unknown_when_no_inference():
    assert normalize_raw_with_description("Widgets", "nothing matches") == "Widgets"
