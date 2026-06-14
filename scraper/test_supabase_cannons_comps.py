import json
import os
import unittest
from unittest import mock
from unittest.mock import patch

import supabase_cannons_comps as scc


class CompRowsTest(unittest.TestCase):
    def test_flattens_items_and_matches_with_rank(self):
        item_exports = {
            "i1": {
                "matches": [
                    {"title": "Pine Chair", "soldPrice": 30, "similarity": 0.91, "source": "cannons"},
                    {"title": "Oak Chair", "soldPrice": 25, "similarity": 0.83, "source": "rasmus"},
                ]
            },
            "i2": {"matches": [{"title": "Lamp", "soldPrice": 12, "similarity": 0.88}]},
        }
        rows = scc.comp_rows("auc", item_exports, "2026-06-05T00:00:00Z")
        self.assertEqual(len(rows), 3)
        # rank is per-item, 0-based, preserving match order.
        i1 = [r for r in rows if r["item_id"] == "i1"]
        self.assertEqual([r["rank"] for r in i1], [0, 1])
        self.assertEqual(i1[0]["match_title"], "Pine Chair")
        self.assertEqual(i1[0]["auction_safe_id"], "auc")
        self.assertEqual(i1[0]["generated_at"], "2026-06-05T00:00:00Z")
        # Every row carries exactly the table columns and is JSON-serializable.
        self.assertEqual(set(rows[0]), set(scc.CANNONS_COMP_COLUMNS))
        json.dumps(rows)

    def test_empty_exports_yield_no_rows(self):
        self.assertEqual(scc.comp_rows("auc", {}, "t"), [])
        self.assertEqual(scc.comp_rows("auc", {"i": {"matches": []}}, "t"), [])


class WriteAuctionCompsTest(unittest.TestCase):
    def test_missing_credentials_raise(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL"):
                scc.write_auction_comps("a", {"i": {"matches": [{"title": "x", "soldPrice": 1}]}}, "t")
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_SECRET_KEY"):
                scc.write_auction_comps(
                    "a", {"i": {"matches": [{"title": "x", "soldPrice": 1}]}}, "t",
                    url="https://x.supabase.co",
                )

    def test_no_matches_writes_nothing(self):
        session = mock.MagicMock()
        written = scc.write_auction_comps(
            "a", {}, "t", url="https://x.supabase.co", key="k", session=session
        )
        self.assertEqual(written, 0)
        session.post.assert_not_called()
        session.delete.assert_not_called()

    def test_inserts_then_prunes_older_generations(self):
        session = mock.MagicMock()
        session.post.return_value = mock.MagicMock(status_code=201)
        session.delete.return_value = mock.MagicMock(status_code=204)

        item_exports = {"i1": {"matches": [{"title": "Chair", "soldPrice": 30, "similarity": 0.9}]}}
        written = scc.write_auction_comps(
            "auc", item_exports, "2026-06-05T00:00:00Z",
            url="https://x.supabase.co/", key="sb_secret_x", session=session,
        )

        self.assertEqual(written, 1)
        # Insert first, then prune.
        post_args, post_kwargs = session.post.call_args
        self.assertEqual(post_args[0], "https://x.supabase.co/rest/v1/cannons_comp_snapshots")
        self.assertEqual(post_kwargs["headers"]["Authorization"], "Bearer sb_secret_x")
        body = json.loads(post_kwargs["data"])
        self.assertEqual(body[0]["match_title"], "Chair")

        del_args, del_kwargs = session.delete.call_args
        self.assertEqual(del_args[0], "https://x.supabase.co/rest/v1/cannons_comp_snapshots")
        self.assertEqual(del_kwargs["params"]["auction_safe_id"], "eq.auc")
        self.assertEqual(del_kwargs["params"]["generated_at"], "lt.2026-06-05T00:00:00Z")

    def test_insert_http_error_raises_before_prune(self):
        session = mock.MagicMock()
        session.post.return_value = mock.MagicMock(status_code=400, text="bad")
        with self.assertRaisesRegex(RuntimeError, "cannons comp insert.*failed"):
            scc.write_auction_comps(
                "auc", {"i": {"matches": [{"title": "x", "soldPrice": 1}]}}, "t",
                url="https://x.supabase.co", key="k", session=session,
            )
        session.delete.assert_not_called()


if __name__ == "__main__":
    unittest.main()
