import os
import unittest
from unittest.mock import patch

from motherduck import (
    append_listing_snapshots,
    rows_for_snapshots,
    should_snapshot_to_motherduck,
)


class MotherDuckSnapshotTest(unittest.TestCase):
    def test_env_flag_controls_snapshotting(self):
        with patch.dict(os.environ, {"GOONERS_MOTHERDUCK_SNAPSHOTS": "1"}, clear=True):
            self.assertTrue(should_snapshot_to_motherduck())

        with patch.dict(os.environ, {"GOONERS_MOTHERDUCK_SNAPSHOTS": "false"}, clear=True):
            self.assertFalse(should_snapshot_to_motherduck())

    def test_rows_map_listing_fields_without_full_objects(self):
        rows = rows_for_snapshots(
            [
                {
                    "auctionId": "auction-1",
                    "auctionSafeId": "auction_safe",
                    "id": "item-1",
                    "lotNumber": 12,
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                    "auctionTitle": "Estate Auction",
                    "auctionEndDate": "2026-06-01T17:00:00+00:00",
                    "endDate": "2026-05-28T18:00:00+00:00",
                    "title": "Sterling bowl",
                    "description": "Nice bowl",
                    "currentBid": 42.5,
                    "totalBids": 3,
                    "category": "Silver",
                    "rawCategory": "Sterling",
                    "detailUrl": "https://example.test/item",
                    "images": ["https://example.test/image.jpg"],
                }
            ],
            "https://example.test/auction",
        )

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["auction_id"], "auction-1")
        self.assertEqual(row["auction_safe_id"], "auction_safe")
        self.assertEqual(row["item_id"], "item-1")
        self.assertEqual(row["current_bid"], "42.50")
        self.assertEqual(row["images"], '["https://example.test/image.jpg"]')
        self.assertEqual(row["source_url"], "https://example.test/auction")

    def test_rows_parse_cannons_local_timestamps(self):
        rows = rows_for_snapshots(
            [
                {
                    "auctionId": "auction-1",
                    "auctionSafeId": "auction_safe",
                    "id": "item-1",
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                    "auctionEndDate": "2026-05-27 8:28:00 PM",
                    "endDate": "2026-05-27 8:28:00 PM",
                }
            ],
            "https://example.test/auction",
        )

        self.assertEqual(rows[0]["auction_end_at"].isoformat(), "2026-05-27T20:28:00-04:00")
        self.assertEqual(rows[0]["item_end_at"].isoformat(), "2026-05-27T20:28:00-04:00")

    def test_enabled_snapshots_require_token(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "MOTHERDUCK_TOKEN"):
                append_listing_snapshots([], "https://example.test/auction")


if __name__ == "__main__":
    unittest.main()
