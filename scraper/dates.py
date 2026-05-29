"""Shared date parsing for Cannon's / Maxanet timestamps.

Cannon's emits timestamps in several formats and without timezone offsets.
Naive values are interpreted as US Eastern (the auction house's local time).
Keep all timestamp parsing here — do not copy DATE_PATTERNS into other modules.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo


AUCTION_TZ = ZoneInfo("America/New_York")

DATE_PATTERNS = (
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %I:%M:%S %p",
    "%Y-%m-%d %H:%M:%S",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
)


def _strptime_any(value: str) -> datetime | None:
    cleaned = value.strip()
    if cleaned.endswith("Z"):
        cleaned = f"{cleaned[:-1]}+0000"
    for pattern in DATE_PATTERNS:
        try:
            return datetime.strptime(cleaned, pattern)
        except ValueError:
            continue
    return None


def parse_auction_datetime(value) -> datetime | None:
    """Parse a Cannon's timestamp into a timezone-aware datetime.

    Accepts strings or ``datetime`` objects. Naive values are interpreted as
    Eastern and returned in that offset (not converted to UTC). Returns ``None``
    when the value is empty or unparseable.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=AUCTION_TZ)

    parsed = _strptime_any(str(value))
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=AUCTION_TZ)


def parse_auction_datetime_utc(value) -> datetime | None:
    """Like :func:`parse_auction_datetime`, but normalized to UTC."""
    parsed = parse_auction_datetime(value)
    return parsed.astimezone(timezone.utc) if parsed else None
