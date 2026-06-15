"""Tests for the canonical, source-aware category mapping (category_canonical.yml
+ build_category_table.py). These pin the behaviour that makes the canonical map
an improvement over the legacy source-blind table: determinism (raw->group does
not depend on description) and source-aware coverage of Rasmus/HiBid vocab.

Run from scraper/:
    uv run --with pyyaml python3 -m pytest test_category_canonical.py
"""

from build_category_table import Resolver, load, validate


def _resolver():
    cfg = load()
    validate(cfg)
    return Resolver(cfg)


R = _resolver()


def group_of(source, raw, text=""):
    sub, _ = R.subcategory(source, raw, text)
    return R.group(sub)


# --- the file is internally consistent ---------------------------------------


def test_yaml_validates():
    cfg = load()
    assert validate(cfg) is True


# --- determinism: raw category wins, description never overrides it -----------


def test_known_raw_is_independent_of_description():
    # Rasmus industrial vocab must not be swayed by stray description keywords
    # (the legacy bug sent "Ind & Warehouse Eqpt" to Jewelry & Watches).
    a = group_of("rasmus", "Ind & Warehouse Eqpt", "comes with a diamond-tipped blade")
    b = group_of("rasmus", "Ind & Warehouse Eqpt", "")
    assert a == b == "Industrial & Equipment"


def test_personal_care_does_not_leak_to_firearms():
    assert (
        group_of("rasmus", "Personal Care Products", "shotgun cleaning kit")
        == "Health & Beauty"
    )


# --- source-aware coverage ----------------------------------------------------


def test_rasmus_industrial_vocab_mapped():
    assert group_of("rasmus", "Auto Parts & Eqpt") == "Vehicles"
    assert group_of("rasmus", "Safety Eqpt & PPE") == "Industrial & Equipment"
    assert group_of("rasmus", "Cleaning & Janitorial") == "Industrial & Equipment"
    assert group_of("rasmus", "HVAC & Plumbing") == "Industrial & Equipment"


def test_hibid_coin_denominations_are_coins():
    for crumb in ("Half Dollars", "Quarters", "Dimes", "Nickels", "Pennies"):
        assert group_of("hibid", crumb) == "Coins & Currency"


def test_hibid_card_crumbs_are_collectibles():
    assert group_of("hibid", "Baseball Trading Cards") == "Collectibles"


# --- identity: upstream canonical display names round-trip --------------------


def test_canonical_display_names_round_trip():
    # The stored rawCategory is the upstream pipeline's display name; it must
    # resolve back to itself, not fall to Other.
    for name in ("Linens & Textiles", "Hot Wheels & Models", "Sterling & Silverplate"):
        assert group_of("cannons", name) != "Other"


# --- inference is a genuine last resort --------------------------------------


def test_inference_only_when_no_raw():
    # Empty raw + a rifle in the title -> Firearms via inference.
    assert (
        group_of("cannons", "", "Winchester rifle, .30-30 lever action") == "Firearms"
    )


def test_unknown_raw_without_signal_is_other():
    assert group_of("cannons", "zzz totally unknown thing") == "Other"


# --- scrapers use the canonical path via categories.py -----------------------


def test_scrapers_route_through_canonical():
    """Verify categories.normalize_category uses source-aware canonical resolution.

    Each scraper passes its source name; these cases only resolve correctly via
    the canonical table, not through the legacy source-blind alias lookup.
    """
    from categories import normalize_category, normalize_raw_with_description

    # Rasmus industrial vocab resolves with the rasmus source
    assert (
        normalize_category("Ind & Warehouse Eqpt", source="rasmus")
        == "Industrial & Equipment"
    )
    assert (
        normalize_category("HVAC & Plumbing", source="rasmus")
        == "Industrial & Equipment"
    )
    assert (
        normalize_category("Safety Eqpt & PPE", source="rasmus")
        == "Industrial & Equipment"
    )

    # HiBid coin denomination breadcrumbs resolve with the hibid source
    assert normalize_category("Half Dollars", source="hibid") == "Coins & Currency"
    assert normalize_category("Quarters", source="hibid") == "Coins & Currency"

    # Cannon's site-specific strings resolve with the cannons source
    assert normalize_category("Art", source="cannons") == "Art"

    # rawCategory is the canonical subcategory name when source is supplied
    assert (
        normalize_raw_with_description("Ind & Warehouse Eqpt", source="rasmus")
        == "Industrial Equipment"
    )
    assert (
        normalize_raw_with_description("Half Dollars", source="hibid")
        == "Coins & Currency"
    )

    # Legacy description inference still works as fallback when canonical has no match
    assert (
        normalize_category(
            "", "Winchester rifle, .30-30 lever action", source="cannons"
        )
        == "Firearms"
    )
