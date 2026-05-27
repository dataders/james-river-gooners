import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from ebay_comps import (
    build_public_exports,
    normalize_match_row,
    write_public_exports,
)


class EbayCompExportTest(unittest.TestCase):
    def test_normalize_match_row_rejects_search_urls(self):
        row = {
            "auction_safe_id": "auction-1",
            "item_id": "item-1",
            "item_web_url": "https://www.ebay.com/sch/i.html?_nkw=Five+sterling+silver+rimmed",
            "title": "Keyword search result",
            "price_value": "55.00",
            "price_currency": "USD",
        }

        self.assertIsNone(normalize_match_row(row))

    def test_build_public_exports_groups_item_matches(self):
        rows = [
            {
                "auction_safe_id": "auction-1",
                "item_id": "item-1",
                "status": "ok",
                "query": "Rosenthal vase",
                "search_url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
                "fetched_at": datetime(2026, 5, 27, 12, 0, tzinfo=timezone.utc),
                "warning": None,
                "ebay_item_id": "177917908706",
                "title": "Vintage Rosenthal vase",
                "price_value": "99.00",
                "price_currency": "USD",
                "shipping_label": "+$21.75 delivery",
                "sold_date": "2026-03-04",
                "sold_date_label": "Sold Mar 4, 2026",
                "thumbnail_url": "https://i.ebayimg.com/example.jpg",
                "item_web_url": "https://www.ebay.com/itm/177917908706",
                "condition": "Pre-Owned",
                "source_query": "specific",
                "match_confidence": "high",
            }
        ]

        exports = build_public_exports(rows, generated_at="2026-05-27T12:00:00Z")

        self.assertEqual(list(exports), ["auction-1"])
        item = exports["auction-1"]["items"]["item-1"]
        self.assertEqual(item["status"], "ok")
        self.assertEqual(item["matches"][0]["itemWebUrl"], "https://www.ebay.com/itm/177917908706")
        self.assertEqual(item["matches"][0]["price"], {"value": "99.00", "currency": "USD"})

    def test_write_public_exports_removes_stale_files_when_rows_exist(self):
        exports = build_public_exports(
            [
                {
                    "auction_safe_id": "auction-1",
                    "item_id": "item-1",
                    "item_web_url": "https://www.ebay.com/itm/177917908706",
                    "title": "Vintage Rosenthal vase",
                    "price_value": "99.00",
                    "price_currency": "USD",
                }
            ],
            generated_at="2026-05-27T12:00:00Z",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "stale.json").write_text("{}")

            written = write_public_exports(exports, output_dir)

            self.assertEqual(written, 1)
            self.assertFalse((output_dir / "stale.json").exists())
            data = json.loads((output_dir / "auction-1.json").read_text())
            self.assertEqual(data["items"]["item-1"]["matches"][0]["price"]["value"], "99.00")


if __name__ == "__main__":
    unittest.main()
