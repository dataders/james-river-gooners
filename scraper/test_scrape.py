import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import pyarrow as pa
import pyarrow.parquet as pq
from scrape import (
    auction_date_from_title,
    count_unique_bidders,
    enrich_unique_bidders,
    has_bid_changes,
    load_existing_bids,
    load_existing_unique_bidders,
)


class AuctionDateFromTitleTest(unittest.TestCase):
    def test_parses_two_digit_year_prefix(self):
        title = "06/04/26: Children's Museum of Richmond | Midlothian VA"
        self.assertEqual(auction_date_from_title(title), "2026-06-04 23:59:59")

    def test_parses_four_digit_year_prefix(self):
        self.assertEqual(
            auction_date_from_title("12/31/2025: Year End Estate Auction"),
            "2025-12-31 23:59:59",
        )

    def test_no_leading_date_returns_empty(self):
        self.assertEqual(auction_date_from_title("Estate Auction | Richmond"), "")

    def test_invalid_calendar_date_returns_empty(self):
        self.assertEqual(auction_date_from_title("13/40/26: Bogus"), "")

    def test_empty_title_returns_empty(self):
        self.assertEqual(auction_date_from_title(""), "")


BID_ROW = """
<tr>
  <td><span>{bidder}</span></td>
  <td>{amount}.00 </td>
  <td>{amount}.00 </td>
  <td><span>{winner}</span></td>
  <td><span class="bid-date-time" data-auc-date="06/03/2026 11:38:02"></span></td>
  <td>{bidnum}</td>
</tr>
"""


def _bidlist_html(bidders):
    rows = "".join(
        BID_ROW.format(bidder=b, winner=b, amount=50 + i, bidnum=i + 1)
        for i, b in enumerate(bidders)
    )
    return f"""
    <table class="table">
      <thead><tr><th>Bidder</th><th>Amount</th><th>Current</th>
        <th>Winning</th><th>Received Date</th><th>Bid#</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
    """


class CountUniqueBiddersTest(unittest.TestCase):
    def test_counts_distinct_masked_bidders(self):
        html = _bidlist_html(["4***2", "4***9", "2***7", "4***9", "4***2"])
        self.assertEqual(count_unique_bidders(html), 3)

    def test_single_bidder(self):
        self.assertEqual(count_unique_bidders(_bidlist_html(["4***2"])), 1)

    def test_no_table_returns_zero(self):
        self.assertEqual(count_unique_bidders("<div>no bids yet</div>"), 0)

    def test_empty_body_returns_zero(self):
        self.assertEqual(count_unique_bidders(_bidlist_html([])), 0)


class LoadExistingUniqueBiddersTest(unittest.TestCase):
    def test_returns_empty_when_file_missing(self):
        self.assertEqual(
            load_existing_unique_bidders(Path("/nonexistent/auction.parquet")), {}
        )

    def test_reads_from_ndjson_skipping_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "auction.parquet"
            ndjson = path.with_suffix(".ndjson")
            ndjson.write_text(
                '{"id":"item-1","uniqueBidders":3}\n'
                '{"id":"item-2"}\n'  # no uniqueBidders → skipped
                '{"id":"item-3","uniqueBidders":0}\n'
            )
            result = load_existing_unique_bidders(path)
        self.assertEqual(result, {"item-1": 3, "item-3": 0})


class EnrichUniqueBiddersTest(unittest.TestCase):
    def test_zero_bid_lots_get_zero_without_fetch(self):
        session = MagicMock()
        items = [{"id": "a", "totalBids": 0}]
        enrich_unique_bidders(session, items, {}, {})
        self.assertEqual(items[0]["uniqueBidders"], 0)
        session.get.assert_not_called()

    def test_carries_forward_when_bid_total_unchanged(self):
        session = MagicMock()
        items = [{"id": "a", "totalBids": 5}]
        enrich_unique_bidders(session, items, {"a": (50.0, 5)}, {"a": 3})
        self.assertEqual(items[0]["uniqueBidders"], 3)
        session.get.assert_not_called()

    def test_fetches_when_bid_total_changed(self):
        session = MagicMock()
        session.get.return_value = MagicMock(
            text=_bidlist_html(["4***2", "4***9"]), raise_for_status=lambda: None
        )
        items = [{"id": "a", "totalBids": 7}]
        enrich_unique_bidders(session, items, {"a": (50.0, 5)}, {"a": 3})
        self.assertEqual(items[0]["uniqueBidders"], 2)
        session.get.assert_called_once()

    def test_fetch_failure_falls_back_to_prior_count(self):
        session = MagicMock()
        session.get.side_effect = RuntimeError("network down")
        items = [{"id": "a", "totalBids": 7}]
        enrich_unique_bidders(session, items, {"a": (50.0, 5)}, {"a": 3})
        self.assertEqual(items[0]["uniqueBidders"], 3)

    def test_fetch_failure_with_no_prior_leaves_field_unset(self):
        session = MagicMock()
        session.get.side_effect = RuntimeError("network down")
        items = [{"id": "a", "totalBids": 7}]
        enrich_unique_bidders(session, items, {}, {})
        self.assertNotIn("uniqueBidders", items[0])


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
