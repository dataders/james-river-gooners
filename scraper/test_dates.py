"""Tests for the centralized date parsing in dates.py."""

from datetime import datetime, timezone

from dates import (
    AUCTION_TZ,
    parse_auction_datetime,
    parse_auction_datetime_utc,
)


def test_empty_and_none_return_none():
    assert parse_auction_datetime("") is None
    assert parse_auction_datetime(None) is None
    assert parse_auction_datetime_utc("") is None


def test_unparseable_string_returns_none():
    assert parse_auction_datetime("not a date") is None


def test_iso_with_offset_is_preserved():
    parsed = parse_auction_datetime("2026-01-02T03:04:05+00:00")
    assert parsed == datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def test_iso_with_microseconds_and_offset():
    parsed = parse_auction_datetime("2026-01-02T03:04:05.123456+00:00")
    assert parsed.microsecond == 123456
    assert parsed.utcoffset() == timezone.utc.utcoffset(None)


def test_z_suffix_is_treated_as_utc():
    parsed = parse_auction_datetime("2026-01-02T03:04:05Z")
    assert parsed == datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)


def test_naive_iso_is_interpreted_as_eastern():
    parsed = parse_auction_datetime("2026-01-02T03:04:05")
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == datetime(2026, 1, 2, tzinfo=AUCTION_TZ).utcoffset()


def test_maxanet_12_hour_format():
    parsed = parse_auction_datetime("2026-01-02 03:04:05 PM")
    assert (parsed.hour, parsed.minute, parsed.second) == (15, 4, 5)
    # naive -> interpreted as Eastern
    assert parsed.tzinfo is not None


def test_us_slash_date_24_hour():
    parsed = parse_auction_datetime("01/02/2026 15:04:05")
    assert (parsed.year, parsed.month, parsed.day) == (2026, 1, 2)
    assert (parsed.hour, parsed.minute) == (15, 4)


def test_us_slash_date_12_hour():
    parsed = parse_auction_datetime("01/02/2026 03:04:05 PM")
    assert parsed.hour == 15


def test_datetime_input_naive_gets_eastern():
    naive = datetime(2026, 1, 2, 3, 4, 5)
    parsed = parse_auction_datetime(naive)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == datetime(2026, 1, 2, tzinfo=AUCTION_TZ).utcoffset()


def test_datetime_input_aware_is_unchanged():
    aware = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    assert parse_auction_datetime(aware) == aware


def test_utc_helper_converts_eastern_to_utc():
    # An Eastern wall-clock time in winter (EST = UTC-5).
    parsed = parse_auction_datetime_utc("2026-01-02 12:00:00")
    assert parsed.tzinfo == timezone.utc
    assert parsed.hour == 17  # noon EST -> 17:00 UTC


def test_utc_helper_passes_through_offset_aware():
    parsed = parse_auction_datetime_utc("2026-06-01T12:00:00+00:00")
    assert parsed == datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
