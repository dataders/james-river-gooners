import tempfile
import unittest
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from scrape import has_bid_changes, load_existing_bids


class LoadExistingBidsTest(unittest.TestCase):
    def test_returns_empty_when_file_missing(self):
        result = load_existing_bids(Path("/nonexistent/auction.parquet"))
        self.assertEqual(result, {})

    def test_reads_id_current_bid_and_total_bids(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "auction.parquet"
            pq.write_table(
                pa.Table.from_pylist([
                    {"id": "item-1", "currentBid": 50.0, "totalBids": 5},
                    {"id": "item-2", "currentBid": 100.0, "totalBids": 12},
                ]),
                path,
            )
            result = load_existing_bids(path)
        self.assertEqual(result, {"item-1": (50.0, 5), "item-2": (100.0, 12)})

    def test_returns_empty_on_corrupt_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "broken.parquet"
            path.write_bytes(b"not a parquet file")
            result = load_existing_bids(path)
        self.assertEqual(result, {})


class HasBidChangesTest(unittest.TestCase):
    def _item(self, item_id, bid, bids):
        return {"id": item_id, "currentBid": bid, "totalBids": bids}

    def test_returns_true_when_no_existing_bids(self):
        items = [self._item("item-1", 50.0, 5)]
        self.assertTrue(has_bid_changes(items, {}))

    def test_returns_false_when_bids_identical(self):
        items = [self._item("item-1", 50.0, 5), self._item("item-2", 100.0, 12)]
        existing = {"item-1": (50.0, 5), "item-2": (100.0, 12)}
        self.assertFalse(has_bid_changes(items, existing))

    def test_returns_true_when_current_bid_rises(self):
        items = [self._item("item-1", 75.0, 5)]
        existing = {"item-1": (50.0, 5)}
        self.assertTrue(has_bid_changes(items, existing))

    def test_returns_true_when_total_bids_increases(self):
        items = [self._item("item-1", 50.0, 8)]
        existing = {"item-1": (50.0, 5)}
        self.assertTrue(has_bid_changes(items, existing))

    def test_returns_true_when_new_item_appears(self):
        items = [self._item("item-1", 50.0, 5), self._item("item-2", 100.0, 2)]
        existing = {"item-1": (50.0, 5)}
        self.assertTrue(has_bid_changes(items, existing))

    def test_returns_true_when_item_disappears(self):
        items = [self._item("item-1", 50.0, 5)]
        existing = {"item-1": (50.0, 5), "item-2": (100.0, 12)}
        self.assertTrue(has_bid_changes(items, existing))

    def test_handles_none_bid_values_as_zero(self):
        items = [{"id": "item-1", "currentBid": None, "totalBids": None}]
        existing = {"item-1": (0.0, 0)}
        self.assertFalse(has_bid_changes(items, existing))


if __name__ == "__main__":
    unittest.main()
