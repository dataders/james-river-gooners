import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import cannons_comps


def _unit(vec):
    v = np.array(vec, dtype=np.float32)
    return v / np.linalg.norm(v)


class TopMatchesTest(unittest.TestCase):
    def setUp(self):
        # Three corpus rows pointing in distinct directions.
        self.rows = [
            {"id": "a", "title": "A", "currentBid": 10},
            {"id": "b", "title": "B", "currentBid": 20},
            {"id": "c", "title": "C", "currentBid": 30},
        ]
        self.corpus = np.vstack([_unit([1, 0]), _unit([0.9, 0.1]), _unit([0, 1])])

    def test_orders_by_descending_similarity(self):
        matches = cannons_comps.top_matches(_unit([1, 0]), self.corpus, self.rows, top_k=3, min_sim=0.0)
        self.assertEqual([m["title"] for m in matches], ["A", "B", "C"])
        self.assertGreaterEqual(matches[0]["similarity"], matches[1]["similarity"])

    def test_threshold_drops_dissimilar(self):
        matches = cannons_comps.top_matches(_unit([1, 0]), self.corpus, self.rows, top_k=3, min_sim=0.5)
        # The orthogonal row (C, sim 0) is excluded.
        self.assertEqual([m["title"] for m in matches], ["A", "B"])

    def test_top_k_caps_results(self):
        matches = cannons_comps.top_matches(_unit([1, 0]), self.corpus, self.rows, top_k=1, min_sim=0.0)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["title"], "A")

    def test_empty_corpus_returns_nothing(self):
        self.assertEqual(
            cannons_comps.top_matches(_unit([1, 0]), np.empty((0, 0)), [], top_k=3, min_sim=0.0),
            [],
        )


class CompMatchShapeTest(unittest.TestCase):
    def test_shapes_archived_lot(self):
        item = {
            "id": "x",
            "title": "Vintage Lamp",
            "currentBid": 42.5,
            "auctionEndDate": "2026-05-21 23:59:59",
            "images": ["https://img/1.jpg", "https://img/2.jpg"],
            "detailUrl": "https://bid/itm/1",
            "auctionTitle": "05/21/26: Estate",
            "source": "cannons",
        }
        m = cannons_comps.comp_match(item, 0.873421)
        self.assertEqual(m["soldPrice"], 42.5)
        self.assertEqual(m["thumbnailUrl"], "https://img/1.jpg")
        self.assertEqual(m["similarity"], 0.8734)
        self.assertEqual(m["source"], "cannons")

    def test_first_image_handles_json_string(self):
        self.assertEqual(
            cannons_comps.first_image({"images": '["https://img/a.jpg"]'}),
            "https://img/a.jpg",
        )

    def test_sold_price_coerces(self):
        self.assertEqual(cannons_comps.sold_price({"currentBid": "15"}), 15.0)
        self.assertEqual(cannons_comps.sold_price({"currentBid": None}), 0.0)

    def test_display_title_falls_back_to_description_for_generic_lots(self):
        item = {"title": "Lot - 207", "description": "Porter-Cable air compressor 6-gallon"}
        self.assertEqual(cannons_comps.display_title(item), "Porter-Cable air compressor 6-gallon")

    def test_display_title_keeps_real_titles(self):
        self.assertEqual(
            cannons_comps.display_title({"title": "Vintage Oak Dresser", "description": "x"}),
            "Vintage Oak Dresser",
        )


class BuildCompsIntegrationTest(unittest.TestCase):
    def test_writes_per_auction_read_model(self):
        # Active item "chair" should match the archived "chair2" (same direction)
        # and not the orthogonal archived "vase".
        embeds = {
            "act:chair": _unit([1, 0]),
            "arc:chair2": _unit([0.95, 0.05]),
            "arc:vase": _unit([0, 1]),
        }

        def fake_ensure(entry, items, embed_missing=True):
            return {it["id"]: embeds[f"{entry['safeId']}:{it['id']}"] for it in items}

        active = {"safeId": "act", "items": [{"id": "chair", "title": "Oak Chair"}]}
        archive = {
            "safeId": "arc",
            "items": [
                {"id": "chair2", "title": "Pine Chair", "currentBid": 30, "images": ["u"], "source": "cannons"},
                {"id": "vase", "title": "Glass Vase", "currentBid": 50, "source": "rasmus"},
            ],
        }

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            out_dir = data_dir / "cannons-comps"
            with mock.patch.object(cannons_comps, "read_manifest", side_effect=lambda p: (
                [active] if p.name == "manifest.json" else [archive]
            )), mock.patch.object(
                cannons_comps, "load_items", side_effect=lambda e: list(e["items"])
            ), mock.patch.object(cannons_comps, "ensure_embeddings", side_effect=fake_ensure):
                summary = cannons_comps.build_comps(
                    data_dir=data_dir, output_dir=out_dir, top_k=5, min_sim=0.5
                )

            self.assertEqual(summary["files_written"], 1)
            payload = json.loads((out_dir / "act.json").read_text())
            matches = payload["items"]["chair"]["matches"]
            # Only the similar chair survives the 0.5 threshold.
            self.assertEqual([m["title"] for m in matches], ["Pine Chair"])
            self.assertEqual(matches[0]["soldPrice"], 30)


if __name__ == "__main__":
    unittest.main()
