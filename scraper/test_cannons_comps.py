import unittest
from unittest import mock

import cannons_comps


class ShapeMatchTest(unittest.TestCase):
    def test_maps_rpc_row_to_comp_shape(self):
        row = {
            "item_id": "x",
            "comp_auction_safe_id": "arc",
            "comp_item_id": "c1",
            "similarity": 0.873421,
            "title": "Vintage Lamp",
            "sold_price": "42.5",
            "sold_at": "2026-05-21T23:59:59+00:00",
            "image_url": "https://img/1.jpg",
            "detail_url": "https://bid/itm/1",
            "auction_title": "05/21/26: Estate",
            "source": "cannons",
        }
        m = cannons_comps.shape_match(row)
        self.assertEqual(m["title"], "Vintage Lamp")
        self.assertEqual(m["soldPrice"], 42.5)
        self.assertEqual(m["soldDate"], "2026-05-21T23:59:59+00:00")
        self.assertEqual(m["thumbnailUrl"], "https://img/1.jpg")
        self.assertEqual(m["detailUrl"], "https://bid/itm/1")
        self.assertEqual(m["auctionTitle"], "05/21/26: Estate")
        self.assertEqual(m["source"], "cannons")
        self.assertEqual(m["similarity"], 0.8734)

    def test_handles_missing_price(self):
        m = cannons_comps.shape_match(
            {"item_id": "x", "comp_item_id": "c", "similarity": 0.5}
        )
        self.assertIsNone(m["soldPrice"])
        self.assertEqual(m["similarity"], 0.5)


class BuildCompsTest(unittest.TestCase):
    def _rows(self):
        # Two matches for item "chair" (best-first, as the RPC returns), one for "vase".
        return [
            {
                "item_id": "chair",
                "comp_item_id": "c2",
                "similarity": 0.95,
                "title": "Pine Chair",
                "sold_price": 30,
            },
            {
                "item_id": "chair",
                "comp_item_id": "c3",
                "similarity": 0.82,
                "title": "Oak Chair",
                "sold_price": 45,
            },
            {
                "item_id": "vase",
                "comp_item_id": "v9",
                "similarity": 0.88,
                "title": "Glass Vase",
                "sold_price": 50,
            },
        ]

    def test_groups_by_item_and_writes_to_supabase(self):
        captured = {}

        def fake_write(safe_id, item_exports, generated_at, **kwargs):
            captured["safe_id"] = safe_id
            captured["item_exports"] = item_exports
            return sum(len(v["matches"]) for v in item_exports.values())

        with (
            mock.patch.object(
                cannons_comps, "read_manifest", return_value=[{"safeId": "act"}]
            ),
            mock.patch.object(cannons_comps, "fetch_comps", return_value=self._rows()),
            mock.patch(
                "supabase_cannons_comps.write_auction_comps", side_effect=fake_write
            ),
        ):
            summary = cannons_comps.build_comps(
                supabase_url="https://x.supabase.co",
                supabase_key="secret",
                top_k=3,
                min_sim=0.5,
            )

        self.assertEqual(summary["auctions"], 1)
        self.assertEqual(summary["items_with_comps"], 2)
        self.assertEqual(summary["matches"], 3)
        self.assertEqual(summary["rows_written"], 3)
        # Best-first order preserved within an item.
        chair = captured["item_exports"]["chair"]["matches"]
        self.assertEqual([m["title"] for m in chair], ["Pine Chair", "Oak Chair"])
        self.assertEqual(chair[0]["soldPrice"], 30)

    def test_emits_completed_telemetry(self):
        events = []
        with (
            mock.patch.object(
                cannons_comps, "read_manifest", return_value=[{"safeId": "act"}]
            ),
            mock.patch.object(cannons_comps, "fetch_comps", return_value=self._rows()),
            mock.patch("supabase_cannons_comps.write_auction_comps", return_value=3),
            mock.patch.object(
                cannons_comps,
                "_telemetry_capture",
                side_effect=lambda e, p=None: events.append((e, p or {})),
            ),
        ):
            cannons_comps.build_comps(
                supabase_url="https://x.supabase.co",
                supabase_key="secret",
                top_k=3,
                min_sim=0.5,
            )
        self.assertIn("cannons_comps_completed", [e for e, _ in events])
        props = dict(events)["cannons_comps_completed"]
        self.assertEqual(props["auctions"], 1)
        self.assertEqual(props["items_with_comps"], 2)
        self.assertEqual(props["rows_written"], 3)
        self.assertEqual(props["top_k"], 3)
        self.assertEqual(props["min_sim"], 0.5)
        self.assertFalse(props["dry_run"])

    def test_from_supabase_reads_active_list_from_lots_table(self):
        with (
            mock.patch(
                "supabase_lots.list_auction_safe_ids", return_value=["act"]
            ) as lister,
            mock.patch.object(cannons_comps, "read_manifest") as manifest,
            mock.patch.object(cannons_comps, "fetch_comps", return_value=self._rows()),
            mock.patch("supabase_cannons_comps.write_auction_comps", return_value=3),
        ):
            summary = cannons_comps.build_comps(
                supabase_url="https://x.supabase.co",
                supabase_key="secret",
                from_supabase=True,
                top_k=3,
                min_sim=0.5,
            )
        lister.assert_called_once_with(archived=False)
        manifest.assert_not_called()  # Supabase replaces the local manifest
        self.assertEqual(summary["auctions"], 1)
        self.assertEqual(summary["rows_written"], 3)

    def test_dry_run_does_not_write(self):
        with (
            mock.patch.object(
                cannons_comps, "read_manifest", return_value=[{"safeId": "act"}]
            ),
            mock.patch.object(cannons_comps, "fetch_comps", return_value=self._rows()),
            mock.patch("supabase_cannons_comps.write_auction_comps") as writer,
        ):
            summary = cannons_comps.build_comps(
                supabase_url="https://x.supabase.co",
                supabase_key="secret",
                dry_run=True,
            )
        writer.assert_not_called()
        self.assertEqual(summary["rows_written"], 0)
        self.assertEqual(summary["items_with_comps"], 2)

    def test_noop_without_supabase_key(self):
        with (
            mock.patch.object(
                cannons_comps, "read_manifest", return_value=[{"safeId": "act"}]
            ),
            mock.patch.object(cannons_comps, "fetch_comps") as fetch,
        ):
            summary = cannons_comps.build_comps(
                supabase_url="https://x.supabase.co", supabase_key=None
            )
        fetch.assert_not_called()
        self.assertEqual(summary["auctions"], 0)


if __name__ == "__main__":
    unittest.main()
