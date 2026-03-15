"""
Category normalization for Cannon's Auctions (Maxanet).

Reads mappings from category_mappings.yml.
"""

from pathlib import Path

import yaml

_MAPPINGS_PATH = Path(__file__).resolve().parent / "category_mappings.yml"

def _load_mappings():
    with open(_MAPPINGS_PATH) as f:
        return yaml.safe_load(f)

_config = _load_mappings()

# Build alias lookup: lowercased variant -> canonical name
_ALIAS_LOOKUP = {}
for canonical, variants in _config["raw_aliases"].items():
    for v in variants:
        _ALIAS_LOOKUP[str(v).lower().strip()] = canonical

# Group mappings
CATEGORY_GROUPS = _config["groups"]

# Description keywords: list of (keyword, raw_cat, group)
_DESCRIPTION_KEYWORDS = []
for keyword, (raw_cat, group) in _config["description_keywords"].items():
    _DESCRIPTION_KEYWORDS.append((str(keyword).lower(), raw_cat, group))


def normalize_raw_category(raw: str) -> str:
    """Normalize a raw category name to its canonical form."""
    if not raw:
        return "Other"
    cleaned = raw.strip().strip(",").strip()
    lower = cleaned.lower()
    if lower in _ALIAS_LOOKUP:
        return _ALIAS_LOOKUP[lower]
    if "," in cleaned:
        for part in cleaned.split(","):
            part_lower = part.strip().lower()
            if part_lower in _ALIAS_LOOKUP:
                return _ALIAS_LOOKUP[part_lower]
    return cleaned


def infer_from_description(description: str) -> tuple[str, str] | None:
    """Try to infer category from item description."""
    if not description:
        return None
    lower = description.lower()
    for keyword, raw_cat, group in _DESCRIPTION_KEYWORDS:
        if keyword in lower:
            return raw_cat, group
    return None


def normalize_category(raw_category: str, description: str = "") -> str:
    """Map a raw category string to a broad group name."""
    canonical = normalize_raw_category(raw_category)
    lower = canonical.lower()
    for group, terms in CATEGORY_GROUPS.items():
        for term in terms:
            if term in lower:
                return group
    if canonical == "Other" or lower == "other":
        result = infer_from_description(description)
        if result:
            return result[1]
    return "Other"


def normalize_raw_with_description(raw_category: str, description: str = "") -> str:
    """Normalize raw category, falling back to description inference."""
    canonical = normalize_raw_category(raw_category)
    if canonical == "Other" or not canonical:
        result = infer_from_description(description)
        if result:
            return result[0]
    return canonical
