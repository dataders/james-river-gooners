import json
import unittest
from unittest.mock import MagicMock

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

    def test_raises_on_http_error(self):
        session = MagicMock()
        session.post.return_value = MagicMock(status_code=400, text="bad")
        with self.assertRaises(RuntimeError):
            supabase_enrichment.upsert_enrichment(
                [supabase_enrichment.enrichment_row(ENRICHED_LOT)],
                url="https://proj.supabase.co",
                key="secret",
                session=session,
            )

    def test_maybe_export_noop_without_credentials(self):
        # Force resolve_credentials to return no key.
        orig = supabase_enrichment.resolve_credentials
        supabase_enrichment.resolve_credentials = lambda *a, **k: ("https://x", None)
        try:
            self.assertEqual(supabase_enrichment.maybe_export_enrichment([ENRICHED_LOT]), 0)
        finally:
            supabase_enrichment.resolve_credentials = orig


if __name__ == "__main__":
    unittest.main()
