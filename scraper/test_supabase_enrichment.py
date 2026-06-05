import json
import unittest
from unittest.mock import MagicMock, patch

import requests

import supabase_enrichment


ENRICHED_LOT = {
    "auctionSafeId": "safe1",
    "id": 42,
    "auctionId": "AID",
    "auctionTitle": "Estate Auction 05/27/25",
    "lotNumber": 7,
    "title": "Lot - 7",
    "category": "Electronics",
    "rawCategory": "Other",
    "brand": "Sony",
    "modelOrSku": "WH-1000XM4",
    "condition": "used",
    "productUrl": "https://www.sony.com/wh1000xm4",
    "enrichmentConfidence": "high",
    "enrichmentModel": "claude-haiku-4-5",
    "images": ["https://img/a.jpg", "https://img/b.jpg"],
    "detailUrl": "https://example.test/item",
    "source": "cannons",
}


class EnrichmentRowTest(unittest.TestCase):
    def test_builds_row_with_only_table_columns(self):
        row = supabase_enrichment.enrichment_row(ENRICHED_LOT)
        self.assertEqual(set(row), set(supabase_enrichment.ENRICHMENT_COLUMNS))
        self.assertEqual(row["item_id"], "42")
        self.assertEqual(row["brand"], "Sony")
        self.assertEqual(row["model_or_sku"], "WH-1000XM4")
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(row["model"], "claude-haiku-4-5")
        self.assertEqual(row["image_url"], "https://img/a.jpg")

    def test_unenriched_lot_is_skipped(self):
        # No confidence => not identified => no row (keeps the table a clean index).
        lot = {"auctionSafeId": "s", "id": 1, "enrichmentConfidence": ""}
        self.assertIsNone(supabase_enrichment.enrichment_row(lot))
        self.assertIsNone(supabase_enrichment.enrichment_row({"auctionSafeId": "s", "id": 1}))

    def test_missing_identity_is_skipped(self):
        self.assertIsNone(
            supabase_enrichment.enrichment_row({"id": 1, "enrichmentConfidence": "low"})
        )
        self.assertIsNone(
            supabase_enrichment.enrichment_row({"auctionSafeId": "s", "enrichmentConfidence": "low"})
        )

    def test_images_as_json_string(self):
        lot = dict(ENRICHED_LOT, images=json.dumps(["https://img/c.jpg"]))
        self.assertEqual(supabase_enrichment.enrichment_row(lot)["image_url"], "https://img/c.jpg")

    def test_confidence_normalized(self):
        lot = dict(ENRICHED_LOT, enrichmentConfidence="  HIGH ")
        self.assertEqual(supabase_enrichment.enrichment_row(lot)["confidence"], "high")


class BuildRowsTest(unittest.TestCase):
    def test_only_enriched_lots_and_dedup(self):
        plain = {"auctionSafeId": "s", "id": 9}
        dup = dict(ENRICHED_LOT, brand="Sony2")  # same key, last wins
        rows = supabase_enrichment.build_enrichment_rows([ENRICHED_LOT, plain, dup])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["brand"], "Sony2")


class UpsertTest(unittest.TestCase):
    def _session(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=201)
        return session

    def test_posts_to_table_with_merge_prefer_header(self):
        session = self._session()
        n = supabase_enrichment.upsert_enrichment(
            [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
            url="https://proj.supabase.co",
            key="secret",
            session=session,
        )
        self.assertEqual(n, 1)
        args, kwargs = session.post.call_args
        self.assertTrue(args[0].endswith("/rest/v1/lot_enrichment"))
        self.assertIn("merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(kwargs["headers"]["apikey"], "secret")

    def test_empty_rows_is_noop(self):
        session = self._session()
        self.assertEqual(supabase_enrichment.upsert_enrichment([], session=session), 0)
        session.post.assert_not_called()

    def test_raises_on_permanent_http_error(self):
        # A 4xx (other than 429) is permanent — no retry, raises immediately.
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=400, text="bad")
        with self.assertRaises(RuntimeError):
            supabase_enrichment.upsert_enrichment(
                [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
                url="https://proj.supabase.co",
                key="secret",
                session=session,
            )
        self.assertEqual(session.post.call_count, 1)

    @patch("supabase_enrichment.time.sleep")
    def test_retries_transient_5xx_then_succeeds(self, sleep):
        session = MagicMock()
        session.post.side_effect = [
            MagicMock(status_code=503, text="busy"),
            MagicMock(status_code=201),
        ]
        n = supabase_enrichment.upsert_enrichment(
            [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
            url="https://proj.supabase.co", key="secret", session=session,
        )
        self.assertEqual(n, 1)
        self.assertEqual(session.post.call_count, 2)
        sleep.assert_called_once()  # backed off once before the retry

    @patch("supabase_enrichment.time.sleep")
    def test_retries_on_network_error_then_succeeds(self, sleep):
        session = MagicMock()
        session.post.side_effect = [
            requests.exceptions.ConnectionError("boom"),
            MagicMock(status_code=201),
        ]
        n = supabase_enrichment.upsert_enrichment(
            [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
            url="https://proj.supabase.co", key="secret", session=session,
        )
        self.assertEqual(n, 1)
        self.assertEqual(session.post.call_count, 2)

    @patch("supabase_enrichment.time.sleep")
    def test_gives_up_after_retries_on_persistent_5xx(self, sleep):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=503, text="busy")
        with self.assertRaises(RuntimeError):
            supabase_enrichment.upsert_enrichment(
                [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
                url="https://proj.supabase.co", key="secret", session=session,
                max_retries=2,
            )
        self.assertEqual(session.post.call_count, 3)  # 1 try + 2 retries
        self.assertEqual(sleep.call_count, 2)


class MaybeExportTest(unittest.TestCase):
    def test_noop_without_any_credentials(self):
        with patch.object(supabase_enrichment, "resolve_credentials", lambda *a, **k: (None, None)):
            self.assertEqual(supabase_enrichment.maybe_export_enrichment([ENRICHED_LOT]), 0)

    def test_warns_when_url_set_but_key_missing(self):
        # Half-configured is a likely misconfiguration — warn rather than stay silent.
        with patch.object(supabase_enrichment, "resolve_credentials", lambda *a, **k: ("https://x", None)):
            with patch("builtins.print") as printed:
                self.assertEqual(supabase_enrichment.maybe_export_enrichment([ENRICHED_LOT]), 0)
        self.assertTrue(any("WARNING" in str(c) for c in printed.call_args_list))

    def test_warns_and_does_not_crash_on_upsert_failure(self):
        with patch.object(supabase_enrichment, "resolve_credentials", lambda *a, **k: ("https://x", "secret")):
            with patch.object(supabase_enrichment, "upsert_enrichment", side_effect=RuntimeError("down")):
                with patch("builtins.print") as printed:
                    # Must NOT raise — the scrape's read model is the primary deliverable.
                    self.assertEqual(supabase_enrichment.maybe_export_enrichment([ENRICHED_LOT]), 0)
        self.assertTrue(any("WARNING" in str(c) for c in printed.call_args_list))


if __name__ == "__main__":
    unittest.main()
