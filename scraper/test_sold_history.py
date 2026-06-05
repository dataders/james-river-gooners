import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import sold_history


class FinalPriceTest(unittest.TestCase):
    def test_prefers_final_bid_over_current_bid(self):
        self.assertEqual(sold_history.final_price({"finalBid": 120.0, "currentBid": 50.0}), 120.0)

    def test_falls_back_to_current_bid_when_no_final(self):
        # Lots archived before #94 carry no finalBid.
        self.assertEqual(sold_history.final_price({"currentBid": 75.0}), 75.0)

    def test_zero_or_missing_means_unsold(self):
        self.assertIsNone(sold_history.final_price({"finalBid": 0, "currentBid": 0}))
        self.assertIsNone(sold_history.final_price({}))


class SoldLotRowTest(unittest.TestCase):
    def test_builds_row_with_only_table_columns(self):
        row = sold_history.sold_lot_row({
            "auctionSafeId": "safe1",
            "id": 42,
            "auctionId": "AID",
            "auctionTitle": "Estate Auction 05/27/25",
            "lotNumber": 7,
            "title": "Sterling bowl",
            "description": "Nice bowl",
            "category": "Silver & Metal",
            "rawCategory": "Sterling",
            "finalBid": 120.0,
            "totalBids": 9,
            "uniqueBidders": 4,
            "endDate": "2026-05-27 8:28:00 PM",
            "images": ["https://img/a.jpg", "https://img/b.jpg"],
            "detailUrl": "https://example.test/item",
            "source": "cannons",
        })
        self.assertEqual(set(row), set(sold_history.SOLD_LOT_COLUMNS))
        self.assertEqual(row["item_id"], "42")
        self.assertEqual(row["final_bid"], 120.0)
        self.assertEqual(row["image_url"], "https://img/a.jpg")
        # Maxanet local time is normalized to a UTC ISO string PostgREST accepts.
        self.assertEqual(row["sold_at"], "2026-05-28T00:28:00+00:00")
        json.dumps(row)  # must be JSON-serializable

    def test_unsold_lot_returns_none(self):
        self.assertIsNone(sold_history.sold_lot_row({"auctionSafeId": "s", "id": "1", "currentBid": 0}))

    def test_parquet_stringified_images_are_parsed(self):
        row = sold_history.sold_lot_row({
            "auctionSafeId": "s", "id": "1", "finalBid": 10,
            "images": json.dumps(["https://img/x.jpg"]),
        })
        self.assertEqual(row["image_url"], "https://img/x.jpg")


class BuildRowsTest(unittest.TestCase):
    def test_reads_archive_ndjson_and_dedups(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp)
            (archive / "a.ndjson").write_text(
                "\n".join(json.dumps(o) for o in [
                    {"auctionSafeId": "s", "id": "1", "finalBid": 100, "category": "Silver & Metal"},
                    {"auctionSafeId": "s", "id": "2", "currentBid": 0},  # unsold → skipped
                ]) + "\n",
                encoding="utf-8",
            )
            (archive / "b.ndjson").write_text(
                json.dumps({"auctionSafeId": "s", "id": "1", "finalBid": 150}) + "\n",
                encoding="utf-8",
            )

            rows = sold_history.build_sold_lot_rows(archive)

        # One sold lot for (s,1) — the later snapshot wins — and the unsold one dropped.
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["final_bid"], 150.0)


class UpsertTest(unittest.TestCase):
    def test_empty_rows_no_request(self):
        session = MagicMock()
        self.assertEqual(sold_history.upsert_sold_lots([], "u", "k", session=session), 0)
        session.post.assert_not_called()

    def test_upserts_with_merge_duplicates_header(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=201)
        rows = [{"auction_safe_id": "s", "item_id": str(n), "final_bid": 10.0} for n in range(3)]

        written = sold_history.upsert_sold_lots(
            rows, url="https://x.supabase.co/", key="sb_secret_x", session=session, batch_size=2
        )

        self.assertEqual(written, 3)
        self.assertEqual(session.post.call_count, 2)  # 2 + 1
        args, kwargs = session.post.call_args_list[0]
        self.assertEqual(args[0], "https://x.supabase.co/rest/v1/sold_lots")
        self.assertIn("merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")

    def test_http_error_raises(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=400, text="bad")
        with self.assertRaisesRegex(RuntimeError, "sold_lots upsert failed"):
            sold_history.upsert_sold_lots(
                [{"auction_safe_id": "s", "item_id": "1"}],
                url="https://x.supabase.co", key="k", session=session,
            )


if __name__ == "__main__":
    unittest.main()
