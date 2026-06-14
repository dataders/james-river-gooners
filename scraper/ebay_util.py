"""Shared primitive helpers for the eBay comps pipeline.

No cross-module imports — only stdlib.
"""

import random
import re
from datetime import date, datetime, UTC
from decimal import Decimal, InvalidOperation
from time import sleep


def utc_now_text() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_value(value):
    if isinstance(value, datetime):
        return value.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    return value


def text_value(value, default: str = "") -> str:
    if value is None:
        return default
    return str(json_value(value))


def decimal_text(value) -> str:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        amount = Decimal("0")
    return f"{amount:.2f}"


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def jitter_sleep(base_seconds: float, _rand=random.uniform) -> None:
    if base_seconds <= 0:
        return
    sleep(_rand(base_seconds * 0.5, base_seconds * 2.5))
