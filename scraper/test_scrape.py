import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

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


class EmbeddingsOnNoBidChangesTest(unittest.TestCase):
    """When GOONERS_EMBEDDINGS=1 and no .embeddings file exists, generate_and_write
    is called even on the no-bid-changes early return."""

    _URL = "https://bid.cannonsauctions.com/Public/Auction/Details?AuctionId=testid"
    _ITEMS = [{"id": "item-1", "currentBid": 50.0, "totalBids": 5,
               "title": "Oak Table", "description": "", "images": [],
               "category": "Furniture"}]
    _EXISTING = {"item-1": (50.0, 5)}  # identical → no changes

    def _run(self, tmp: Path, env: dict, pre_create_embeddings: bool = False):
        from scrape import scrape_auction
        if pre_create_embeddings:
            (tmp / "testid.embeddings").write_bytes(b"placeholder")
        mock_embed = mock.MagicMock()
        patches = [
            mock.patch("scrape.create_session", return_value=(mock.Mock(), "<html>")),
            mock.patch("scrape.extract_page_size_token", return_value="tok"),
            mock.patch("scrape.extract_auction_title", return_value="Test Auction"),
            mock.patch("scrape.fetch_categories", return_value={}),
            mock.patch("scrape.fetch_items_page", return_value="<html>"),
            mock.patch("scrape.extract_total_pages", return_value=1),
            mock.patch("scrape.parse_items_html", return_value=list(self._ITEMS)),
            mock.patch("scrape.load_existing_bids", return_value=dict(self._EXISTING)),
            mock.patch("scrape.ITEMS_DIR", tmp),
            mock.patch.dict(sys.modules, {"embed": mock_embed}),
        ]
        with ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            stack.enter_context(mock.patch.dict(os.environ, env))
            result = scrape_auction(self._URL)
        return result, mock_embed.generate_and_write

    def test_generates_embeddings_when_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result, mock_gen = self._run(Path(tmpdir), {"GOONERS_EMBEDDINGS": "1"})
        self.assertEqual(result, {"changed": False})
        mock_gen.assert_called_once()

    def test_skips_generation_when_embeddings_already_exist(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result, mock_gen = self._run(
                Path(tmpdir), {"GOONERS_EMBEDDINGS": "1"}, pre_create_embeddings=True
            )
        self.assertEqual(result, {"changed": False})
        mock_gen.assert_not_called()

    def test_skips_generation_when_env_not_set(self):
        env = {k: v for k, v in os.environ.items() if k != "GOONERS_EMBEDDINGS"}
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, env, clear=True):
                result, mock_gen = self._run(Path(tmpdir), {})
        self.assertEqual(result, {"changed": False})
        mock_gen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
