"""
Shared category normalization for all auction sources.

Used by scrape.py (Cannon's/Maxanet), scrape_hibid.py (HiBid), and
scrape_rasmus.py (Rasmus) so that every source emits the same unified category
vocabulary.

Pass `source` ("cannons", "hibid", or "rasmus") to get source-aware resolution
via the canonical resolver (category_canonical.yml).  Calls without a source
use the legacy alias + group-term path for backward compatibility.
"""

from pathlib import Path

import yaml
from build_category_table import Resolver, load as _load_canonical

_MAPPINGS_PATH = Path(__file__).resolve().parent / "category_mappings.yml"

def _load_mappings():
    with open(_MAPPINGS_PATH) as f:
        return yaml.safe_load(f)

_config = _load_mappings()
_RESOLVER = Resolver(_load_canonical())

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


def normalize_category(raw_category: str, description: str = "", source: str = "") -> str:
    """Map a raw category string to a broad group name.

    When *source* is supplied ("cannons", "hibid", or "rasmus"), resolution goes
    through the canonical source-aware table first, with the legacy
    description-keyword list as a fallback when the canonical inference also
    returns nothing.  Without *source* the legacy alias + group-term path is
    used unchanged for backward compatibility.
    """
    if source:
        sub, _ = _RESOLVER.subcategory(source, raw_category, description)
        if sub != "__unknown__":
            return _RESOLVER.group(sub)
        # Canonical inference is intentionally sparse; try the richer legacy set.
        result = infer_from_description(description)
        if result:
            return result[1]
        return "Other"
    # Legacy path (no source supplied — recategorize.py, etc.)
    canonical = normalize_raw_category(raw_category)
    lower = canonical.lower()
    for group, terms in CATEGORY_GROUPS.items():
        for term in terms:
            if term in lower:
                return group
    result = infer_from_description(description)
    if result:
        return result[1]
    return "Other"


def normalize_raw_with_description(raw_category: str, description: str = "", source: str = "") -> str:
    """Normalize raw category, falling back to description inference.

    Returns the canonical subcategory name when *source* is supplied and the
    canonical table has a mapping; otherwise returns the legacy canonical alias
    or cleaned raw string.
    """
    if source:
        sub, _ = _RESOLVER.subcategory(source, raw_category, description)
        if sub != "__unknown__":
            return sub
        result = infer_from_description(description)
        if result:
            return result[0]
        cleaned = (raw_category or "").strip().strip(",").strip()
        return cleaned or "Other"
    # Legacy path
    canonical = normalize_raw_category(raw_category)
    if canonical == "Other" or not canonical:
        result = infer_from_description(description)
        if result:
            return result[0]
    return canonical
