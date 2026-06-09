"""Shared auction-level filters used across the scrapers.

We only want resale goods, not land/property auctions. The keyword list and the
match check live here so HiBid and Rasmus share one definition instead of Rasmus
importing it from HiBid (an awkward scraper-to-scraper dependency).
"""

REAL_ESTATE_KEYWORDS = [
    "real estate",
    "property auction",
    "land auction",
    "land sale",
    "parcel",
    "acres",
    "foreclosure",
    "tax sale",
    "tax auction",
    "deed",
]


def is_real_estate_auction(title: str) -> bool:
    lower = (title or "").lower()
    return any(kw in lower for kw in REAL_ESTATE_KEYWORDS)
