import unittest
from datetime import datetime, timezone

from scrape_hibid import (
    extract_catalog_id,
    hibid_safe_id,
    is_real_estate_auction,
    parse_date_range_end,
    parse_relative_close_time,
)


class IsRealEstateAuctionTest(unittest.TestCase):
    def test_real_estate_keyword_detected(self):
        self.assertTrue(is_real_estate_auction("Richmond Real Estate Online Auction"))

    def test_property_auction_detected(self):
        self.assertTrue(is_real_estate_auction("Henrico County Property Auction"))

    def test_acres_detected(self):
        self.assertTrue(is_real_estate_auction("Farm Sale - 40 Acres in Goochland"))

    def test_deed_detected(self):
        self.assertTrue(is_real_estate_auction("Tax Deed Sale 2026"))

    def test_foreclosure_detected(self):
        self.assertTrue(is_real_estate_auction("Bank Foreclosure Liquidation"))

    def test_normal_estate_auction_not_flagged(self):
        self.assertFalse(is_real_estate_auction("Current Estate Auction - Furniture & Collectibles"))

    def test_empty_title_not_flagged(self):
        self.assertFalse(is_real_estate_auction(""))

    def test_case_insensitive(self):
        self.assertTrue(is_real_estate_auction("TAX SALE: Delinquent Properties"))


class HibidSafeIdTest(unittest.TestCase):
    def test_int_catalog_id(self):
        self.assertEqual(hibid_safe_id(744897), "hibid_744897")

    def test_str_catalog_id(self):
        self.assertEqual(hibid_safe_id("123456"), "hibid_123456")

    def test_prefix_prevents_maxanet_collision(self):
        sid = hibid_safe_id(999)
        self.assertTrue(sid.startswith("hibid_"))


class ExtractCatalogIdTest(unittest.TestCase):
    def test_full_url(self):
        url = "https://hibid.com/catalog/744897/past-chapters-online-auction/"
        self.assertEqual(extract_catalog_id(url), "744897")

    def test_url_without_slug(self):
        self.assertEqual(extract_catalog_id("https://hibid.com/catalog/12345/"), "12345")

    def test_no_catalog_returns_none(self):
        self.assertIsNone(extract_catalog_id("https://hibid.com/company/79243/"))

    def test_lot_url_returns_none(self):
        self.assertIsNone(extract_catalog_id("https://hibid.com/lot/99999/some-item/"))


class ParseDateRangeEndTest(unittest.TestCase):
    def test_date_range_extracts_end(self):
        result = parse_date_range_end("Auction Dates: 5/20/2026 - 5/27/2026")
        self.assertEqual(result, "2026-05-27T23:00:00+00:00")

    def test_single_date_fallback(self):
        result = parse_date_range_end("Closing: 6/1/2026")
        self.assertEqual(result, "2026-06-01T23:00:00+00:00")

    def test_em_dash_separator(self):
        result = parse_date_range_end("5/20/2026 – 5/27/2026")
        self.assertEqual(result, "2026-05-27T23:00:00+00:00")

    def test_no_date_returns_empty(self):
        self.assertEqual(parse_date_range_end("No dates here"), "")

    def test_single_digit_month_and_day(self):
        result = parse_date_range_end("1/5/2026 - 1/9/2026")
        self.assertEqual(result, "2026-01-09T23:00:00+00:00")


class ParseRelativeCloseTimeTest(unittest.TestCase):
    def setUp(self):
        self.base = datetime(2026, 5, 27, 14, 0, 0, tzinfo=timezone.utc)

    def test_days_hours_minutes(self):
        result = parse_relative_close_time("1d 3h 24m", self.base)
        self.assertEqual(result, "2026-05-28T17:24:00+00:00")

    def test_hours_only(self):
        result = parse_relative_close_time("5h 30m", self.base)
        self.assertEqual(result, "2026-05-27T19:30:00+00:00")

    def test_minutes_only(self):
        result = parse_relative_close_time("45m", self.base)
        self.assertEqual(result, "2026-05-27T14:45:00+00:00")

    def test_zero_duration_returns_empty(self):
        result = parse_relative_close_time("no time here", self.base)
        self.assertEqual(result, "")

    def test_trailing_dash_stripped_by_caller(self):
        # The caller strips the trailing dash before passing to this function
        result = parse_relative_close_time("2d 0h 0m ", self.base)
        self.assertEqual(result, "2026-05-29T14:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
