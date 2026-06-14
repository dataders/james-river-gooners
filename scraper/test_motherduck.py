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
        import motherduck
        import warehouse
        warehouse._CACHED_CONNECTIONS.clear()
        motherduck._SCHEMA_READY.clear()
        self.item = {"id": "i1", "auctionId": "a1", "auctionSafeId": "s1", "title": "x"}

    def test_reuses_connection_and_runs_ddl_once(self):
        from unittest.mock import MagicMock

        import warehouse
        conn = MagicMock()
        with patch.dict(os.environ, {"MOTHERDUCK_TOKEN": "tok"}, clear=True):
            with patch.object(warehouse, "connect", return_value=conn) as opened:
                append_listing_snapshots([self.item], "https://x/a", database="md:test")
                append_listing_snapshots([self.item], "https://x/a", database="md:test")
        from motherduck import CREATE_TABLE_SQL
        # One physical connection for both auctions; never closed by the caller.
        self.assertEqual(opened.call_count, 1)
        conn.close.assert_not_called()
        # The idempotent DDL runs once for the process, not once per append.
        create_calls = [c for c in conn.execute.call_args_list if c.args and c.args[0] == CREATE_TABLE_SQL]
        self.assertEqual(len(create_calls), 1)
        # Each append still bulk-loads its own batch.
        self.assertEqual(conn.register.call_count, 2)
        conn.executemany.assert_not_called()

    def test_reconnects_once_when_connection_goes_stale(self):
        from unittest.mock import MagicMock

        import warehouse
        stale, fresh = MagicMock(), MagicMock()
        stale.execute.side_effect = RuntimeError("connection reset")
        with patch.dict(os.environ, {"MOTHERDUCK_TOKEN": "tok"}, clear=True):
            with patch.object(warehouse, "connect", side_effect=[stale, fresh]):
                n = append_listing_snapshots([self.item], "https://x/a", database="md:test")
        self.assertEqual(n, 1)
        stale.close.assert_called_once()    # dropped after the failure
        fresh.register.assert_called_once()  # batch retried on a new connection


class BulkInsertParityTest(unittest.TestCase):
    """The bulk INSERT … SELECT path must store byte-identical rows to the
    per-row executemany it replaces — including the nasty cases (NULL final_bid
    on a live lot, tz-aware timestamps, decimals, NULL unique_bidders, booleans).
    Run against a real in-memory DuckDB so casts are exercised, not mocked."""

    def _rows(self):
        from motherduck import rows_for_snapshots
        return rows_for_snapshots(
            [
                {  # live lot: no final price yet, no bidder count, comma in text
                    "auctionId": "a1", "auctionSafeId": "s1", "id": "live",
                    "lotNumber": 7, "currentBid": 42.5, "totalBids": 0,
                    "title": 'Chair, "antique"', "description": "oak, worn",
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                    "auctionEndDate": "2026-05-27 8:28:00 PM",
                    "endDate": "2026-05-27 8:28:00 PM",
                },
                {  # closed lot: final price, closed flag, unique bidders
                    "auctionId": "a1", "auctionSafeId": "s1", "id": "closed",
                    "lotNumber": 8, "currentBid": 10, "finalBid": 120.0,
                    "closed": True, "totalBids": 3, "uniqueBidders": 7,
                    "category": "Furniture",
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                },
            ],
            "https://example.test/a1",
        )

    def test_bulk_matches_executemany(self):
        try:
            import duckdb  # noqa: F401
            import pyarrow  # noqa: F401
        except ModuleNotFoundError:
            self.skipTest("duckdb/pyarrow not installed")

        import duckdb
        from motherduck import (
            CREATE_TABLE_SQL,
            INSERT_SNAPSHOT_SQL,
            SNAPSHOT_COLUMN_CASTS,
            SNAPSHOT_TABLE,
            bulk_insert_rows,
            row_values,
        )

        rows = self._rows()
        # Compare only the inserted columns (ingested_at has a now() default).
        # timestamptz is read as ::text so the fetch doesn't require pytz —
        # identical text means an identical stored instant for both paths.
        cols = ", ".join(
            f'"{c}"::text' if cast == "timestamptz" else f'"{c}"'
            for c, cast in SNAPSHOT_COLUMN_CASTS.items()
        )
        select = f"select {cols} from {SNAPSHOT_TABLE} order by item_id"

        con = duckdb.connect(":memory:")
        con.execute(CREATE_TABLE_SQL)
        con.executemany(INSERT_SNAPSHOT_SQL, [row_values(r) for r in rows])
        expected = con.execute(select).fetchall()

        con.execute(f"delete from {SNAPSHOT_TABLE}")
        bulk_insert_rows(con, rows)
        actual = con.execute(select).fetchall()

        self.assertEqual(actual, expected)
        # Guard the specific hazards explicitly so a regression names itself.
        by_id = {r[2]: r for r in actual}  # item_id is column index 2
        self.assertIsNone(by_id["live"][11])       # final_bid NULL, not 0.00
        self.assertIsNone(by_id["live"][14])       # unique_bidders NULL
        self.assertEqual(str(by_id["closed"][11]), "120.00")  # decimal preserved
        self.assertTrue(by_id["closed"][12])       # closed boolean true

    def test_bulk_insert_respects_or_ignore_on_duplicate_pk(self):
        try:
            import duckdb  # noqa: F401
            import pyarrow  # noqa: F401
        except ModuleNotFoundError:
            self.skipTest("duckdb/pyarrow not installed")

        import duckdb
        from motherduck import CREATE_TABLE_SQL, SNAPSHOT_TABLE, bulk_insert_rows

        rows = self._rows()
        con = duckdb.connect(":memory:")
        con.execute(CREATE_TABLE_SQL)
        bulk_insert_rows(con, rows)
        bulk_insert_rows(con, rows)  # same PKs → ignored, not duplicated/erroring
        count = con.execute(f"select count(*) from {SNAPSHOT_TABLE}").fetchone()[0]
        self.assertEqual(count, len(rows))


if __name__ == "__main__":
    unittest.main()
