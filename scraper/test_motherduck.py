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
        # uniqueBidders absent on the item → nullable column maps to None
        self.assertIsNone(row["unique_bidders"])

    def test_open_lot_has_null_final_bid_and_not_closed(self):
        rows = rows_for_snapshots(
            [{"id": "item-1", "currentBid": 42.5}],
            "https://example.test/auction",
        )
        # Live lot: no sold price yet, and not closed.
        self.assertIsNone(rows[0]["final_bid"])
        self.assertEqual(rows[0]["closed"], False)

    def test_closed_lot_carries_final_bid_and_closed_flag(self):
        rows = rows_for_snapshots(
            [{"id": "item-1", "currentBid": 42.5, "finalBid": 120.0, "closed": True}],
            "https://example.test/auction",
        )
        self.assertEqual(rows[0]["final_bid"], "120.00")
        self.assertEqual(rows[0]["closed"], True)

    def test_insert_placeholder_count_matches_row_values(self):
        from motherduck import INSERT_SNAPSHOT_SQL, row_values
        sample = rows_for_snapshots([{"id": "x"}], "u")[0]
        self.assertEqual(INSERT_SNAPSHOT_SQL.count("?"), len(row_values(sample)))

    def test_rows_map_unique_bidders_when_present(self):
        rows = rows_for_snapshots(
            [{"id": "item-1", "totalBids": 8, "uniqueBidders": 6}],
            "https://example.test/auction",
        )
        self.assertEqual(rows[0]["unique_bidders"], 6)

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


class ConnectionReuseTest(unittest.TestCase):
    """Across auctions in one scrape, the snapshot append reuses a single cloud
    connection and runs the (idempotent) DDL once — the per-auction reconnect
    was the dominant cost holding the scrape over its step timeout."""

    def setUp(self):
        import warehouse
        import motherduck
        warehouse._CACHED_CONNECTIONS.clear()
        motherduck._SCHEMA_READY.clear()
        self.item = {"id": "i1", "auctionId": "a1", "auctionSafeId": "s1", "title": "x"}

    def test_reuses_connection_and_runs_ddl_once(self):
        import warehouse
        from unittest.mock import MagicMock
        conn = MagicMock()
        with patch.dict(os.environ, {"MOTHERDUCK_TOKEN": "tok"}, clear=True):
            with patch.object(warehouse, "connect", return_value=conn) as opened:
                append_listing_snapshots([self.item], "https://x/a", database="md:test")
                append_listing_snapshots([self.item], "https://x/a", database="md:test")
        # One physical connection for both auctions; never closed by the caller.
        self.assertEqual(opened.call_count, 1)
        conn.close.assert_not_called()
        # DDL (CREATE + 3 ALTER = 4 execute calls) runs once, not per append.
        self.assertEqual(conn.execute.call_count, 4)
        # But each append still writes its rows.
        self.assertEqual(conn.executemany.call_count, 2)

    def test_reconnects_once_when_connection_goes_stale(self):
        import warehouse
        from unittest.mock import MagicMock
        stale, fresh = MagicMock(), MagicMock()
        stale.executemany.side_effect = RuntimeError("connection reset")
        with patch.dict(os.environ, {"MOTHERDUCK_TOKEN": "tok"}, clear=True):
            with patch.object(warehouse, "connect", side_effect=[stale, fresh]):
                n = append_listing_snapshots([self.item], "https://x/a", database="md:test")
        self.assertEqual(n, 1)
        stale.close.assert_called_once()      # dropped after the failure
        fresh.executemany.assert_called_once()  # retried on a new connection


if __name__ == "__main__":
    unittest.main()
