import os
import unittest
from datetime import UTC, datetime
from unittest.mock import patch

import corpus_reuse as cr

NOW = datetime(2026, 6, 14, tzinfo=UTC)


def _match(ebay_item_id="111222333444", sold_date="2026-05-20", sim=0.9, **over):
    base = {
        "ebay_item_id": ebay_item_id,
        "similarity": sim,
        "title": "Comparable oak chair",
        "sold_price": 250.0,
        "sold_date": sold_date,
        "sold_date_label": f"Sold {sold_date}",
        "condition": "Used",
        "thumbnail_url": "https://i.ebayimg.com/t.jpg",
        "item_web_url": "https://www.ebay.com/itm/111222333444",
    }
    base.update(over)
    return base


class EnabledTest(unittest.TestCase):
    def test_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(cr.corpus_first_enabled())

    def test_on_when_flag_set(self):
        with patch.dict(os.environ, {"GOONERS_CORPUS_FIRST": "1"}, clear=True):
            self.assertTrue(cr.corpus_first_enabled())


class FreshMatchesTest(unittest.TestCase):
    def test_keeps_only_sales_within_window(self):
        matches = [
            _match("a", sold_date="2026-06-01"),  # 13 days — fresh
            _match("b", sold_date="2026-04-20"),  # 55 days — fresh
            _match("c", sold_date="2026-02-01"),  # >60 days — stale
            _match("d", sold_date=None),  # undated — not counted
        ]
        fresh = cr.fresh_matches(matches, max_age_days=60, now=NOW)
        self.assertEqual({m["ebay_item_id"] for m in fresh}, {"a", "b"})

    def test_coverage_threshold(self):
        recent = [_match(str(i), sold_date="2026-06-01") for i in range(3)]
        self.assertTrue(
            cr.has_fresh_coverage(recent, min_fresh=3, max_age_days=60, now=NOW)
        )
        self.assertFalse(
            cr.has_fresh_coverage(recent[:2], min_fresh=3, max_age_days=60, now=NOW)
        )


class ReuseRowsTest(unittest.TestCase):
    def test_shapes_rows_caps_and_buckets(self):
        matches = [
            _match("a", sim=0.91),
            _match("b", sim=0.82),
            _match("c", sim=0.86),
            _match("d", sim=0.99),  # 4th — dropped by the default keep=3
        ]
        rows = cr.reuse_comp_rows(
            matches, "auction-1", "lot-9", "2026-06-14T00:00:00+00:00"
        )
        self.assertEqual(len(rows), 3)  # capped at _KEEP
        self.assertTrue(all(r["source_query"] == "visual" for r in rows))
        self.assertTrue(
            all(
                r["auction_safe_id"] == "auction-1" and r["item_id"] == "lot-9"
                for r in rows
            )
        )
        self.assertEqual(rows[0]["match_confidence"], "high")  # 0.91
        self.assertEqual(rows[1]["match_confidence"], "medium")  # 0.82

    def test_drops_matches_without_a_url(self):
        rows = cr.reuse_comp_rows([_match(item_web_url="")], "a", "1", "t")
        self.assertEqual(rows, [])


class CorpusReuserTest(unittest.TestCase):
    def test_disabled_is_a_noop(self):
        with patch.dict(os.environ, {}, clear=True):
            reuser = cr.CorpusReuser("t", enabled=False)
            self.assertIsNone(reuser.covered_comps({"auctionSafeId": "a", "id": "1"}))

    def _reuser(self, fetched_at="2026-06-14T00:00:00+00:00"):
        # Patch credential resolution so __init__ keeps enabled=True regardless of
        # the ambient env (it correctly self-disables when creds are absent).
        with patch.object(
            cr, "resolve_credentials", return_value=("https://x.supabase.co", "k")
        ):
            return cr.CorpusReuser(fetched_at, enabled=True)

    def test_covered_when_corpus_has_fresh_matches(self):
        reuser = self._reuser()
        fresh = [_match(str(i), sold_date="2026-06-01") for i in range(3)]
        with (
            patch.object(cr, "fetch_item_coverage", return_value=fresh),
            patch.object(cr, "datetime", wraps=cr.datetime) as dt,
        ):
            dt.now.return_value = NOW
            rows = reuser.covered_comps({"auctionSafeId": "a", "id": "1"})
        self.assertIsNotNone(rows)
        self.assertEqual(len(rows), 3)

    def test_not_covered_when_matches_stale(self):
        reuser = self._reuser("t")
        stale = [_match(str(i), sold_date="2026-01-01") for i in range(3)]
        with (
            patch.object(cr, "fetch_item_coverage", return_value=stale),
            patch.object(cr, "datetime", wraps=cr.datetime) as dt,
        ):
            dt.now.return_value = NOW
            self.assertIsNone(reuser.covered_comps({"auctionSafeId": "a", "id": "1"}))

    def test_coverage_error_falls_through_to_api(self):
        reuser = self._reuser("t")
        with patch.object(cr, "fetch_item_coverage", side_effect=RuntimeError("boom")):
            self.assertIsNone(reuser.covered_comps({"auctionSafeId": "a", "id": "1"}))


if __name__ == "__main__":
    unittest.main()
