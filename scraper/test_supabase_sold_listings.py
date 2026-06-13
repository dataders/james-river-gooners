import json
import os
import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

import supabase_sold_listings as ssl


def _candidate(ebay_item_id="111", **overrides):
    base = {
        "ebay_item_id": ebay_item_id,
        "title": "Vintage Rosenthal crackle glaze vase",
        "price_value": Decimal("99.00"),
        "price_currency": "USD",
        "shipping_label": "Free shipping",
        "sold_date": date(2026, 3, 4),
        "sold_date_label": "Sold Mar 4, 2026",
        "thumbnail_url": "https://i.ebayimg.com/thumb.jpg",
        "item_web_url": "https://www.ebay.com/itm/111",
        "condition": "Used",
        "source_query": "specific",
        "query": "rosenthal crackle vase",
        "category": "China & Pottery",
        "last_seen_at": "2026-06-13T22:00:00+00:00",
    }
    base.update(overrides)
    return base


class CorpusEnabledTest(unittest.TestCase):
    def test_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(ssl.sold_listings_corpus_enabled())

    def test_on_when_flag_truthy(self):
        for value in ("1", "true", "True"):
            with patch.dict(os.environ, {"GOONERS_SOLD_LISTINGS_CORPUS": value}, clear=True):
                self.assertTrue(ssl.sold_listings_corpus_enabled())

    def test_off_for_other_values(self):
        with patch.dict(os.environ, {"GOONERS_SOLD_LISTINGS_CORPUS": "0"}, clear=True):
            self.assertFalse(ssl.sold_listings_corpus_enabled())


class BuildRowsTest(unittest.TestCase):
    def test_projects_only_table_columns_json_safe(self):
        rows = ssl.build_sold_listing_rows([_candidate()])
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(set(row), set(ssl.SOLD_LISTING_COLUMNS))
        self.assertNotIn("first_seen_at", row)  # default-filled, never sent
        self.assertNotIn("match_confidence", row)  # not a corpus column
        self.assertEqual(row["price_value"], 99.0)  # Decimal -> float
        self.assertEqual(row["sold_date"], "2026-03-04")  # date -> isoformat
        json.dumps(row)  # must be PostgREST-serializable

    def test_dedupes_by_ebay_item_id_last_wins(self):
        rows = ssl.build_sold_listing_rows([
            _candidate("777", title="first"),
            _candidate("777", title="second"),
            _candidate("888"),
        ])
        by_id = {r["ebay_item_id"]: r for r in rows}
        self.assertEqual(set(by_id), {"777", "888"})
        self.assertEqual(by_id["777"]["title"], "second")

    def test_drops_listings_without_id_or_url(self):
        rows = ssl.build_sold_listing_rows([
            _candidate("", item_web_url="https://www.ebay.com/itm/1"),
            _candidate("222", item_web_url=""),
            _candidate("333"),
        ])
        self.assertEqual([r["ebay_item_id"] for r in rows], ["333"])


class UpsertTest(unittest.TestCase):
    def test_empty_rows_no_request(self):
        session = MagicMock()
        self.assertEqual(ssl.upsert_sold_listings([], "u", "k", session=session), 0)
        session.post.assert_not_called()

    def test_missing_credentials_raise(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL"):
                ssl.upsert_sold_listings([{"ebay_item_id": "1"}])
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_SECRET_KEY"):
                ssl.upsert_sold_listings([{"ebay_item_id": "1"}], url="https://x.supabase.co")

    def test_posts_batches_with_merge_duplicates(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=201)
        rows = ssl.build_sold_listing_rows([_candidate(str(n)) for n in range(3)])

        written = ssl.upsert_sold_listings(
            rows, url="https://x.supabase.co/", key="sb_secret_x", session=session, batch_size=2
        )

        self.assertEqual(written, 3)
        self.assertEqual(session.post.call_count, 2)  # 2 + 1
        _, kwargs = session.post.call_args_list[0]
        self.assertEqual(
            session.post.call_args_list[0][0][0],
            "https://x.supabase.co/rest/v1/sold_listings",
        )
        self.assertIn("resolution=merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")


class MaybeExportTest(unittest.TestCase):
    def test_noop_when_feature_off(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ssl.maybe_export_sold_listings([_candidate()]), 0)

    def test_warns_when_url_set_but_no_key(self):
        with patch.dict(
            os.environ,
            {"GOONERS_SOLD_LISTINGS_CORPUS": "1", "SUPABASE_URL": "https://x.supabase.co"},
            clear=True,
        ):
            self.assertEqual(ssl.maybe_export_sold_listings([_candidate()]), 0)

    def test_writes_when_enabled_and_configured(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=201)
        with patch.dict(
            os.environ,
            {
                "GOONERS_SOLD_LISTINGS_CORPUS": "1",
                "SUPABASE_URL": "https://x.supabase.co",
                "SUPABASE_SECRET_KEY": "sb_secret_x",
            },
            clear=True,
        ):
            written = ssl.maybe_export_sold_listings([_candidate("1"), _candidate("2")], session=session)
        self.assertEqual(written, 2)
        session.post.assert_called_once()


if __name__ == "__main__":
    unittest.main()
