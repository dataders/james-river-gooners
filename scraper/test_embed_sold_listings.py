import json
import unittest

import embed_sold_listings as esl


class ListingToItemTest(unittest.TestCase):
    def test_uses_condition_as_description_image_from_thumbnail(self):
        row = {
            "ebay_item_id": "123456789012",
            "title": "Stickley Maple Ladder Back Chair",
            "condition": "Used",
            "thumbnail_url": "https://i.ebayimg.com/thumb.jpg",
            # raw_json is ignored — only condition + image are used for clean embeddings
            "raw_json": {
                "subtitle": "Early American primitive style",
                "soldPrice": 879.0,
            },
        }
        item = esl.listing_to_item(row)
        self.assertEqual(item["id"], "123456789012")
        self.assertEqual(item["title"], "Stickley Maple Ladder Back Chair")
        self.assertEqual(item["images"], ["https://i.ebayimg.com/thumb.jpg"])
        self.assertEqual(item["description"], "Used")
        self.assertNotIn("Early American primitive style", item["description"])

    def test_empty_condition_and_missing_thumbnail(self):
        row = {
            "ebay_item_id": "9",
            "title": "Oak Cabinet",
            "condition": "",
            "thumbnail_url": None,
            "raw_json": json.dumps({"subtitle": "quarter sawn"}),
        }
        item = esl.listing_to_item(row)
        self.assertEqual(item["images"], [])  # no thumbnail -> text-only embed
        self.assertEqual(item["description"], "")  # no condition -> empty

    def test_prefers_full_res_thumbnail_url(self):
        item = esl.listing_to_item(
            {
                "ebay_item_id": "5",
                "title": "Chair",
                "full_res_thumbnail_url": "https://i.ebayimg.com/full.jpg",
                "thumbnail_url": "https://i.ebayimg.com/thumb.jpg",
            }
        )
        self.assertEqual(item["images"], ["https://i.ebayimg.com/full.jpg"])

    def test_tolerates_absent_raw_json(self):
        item = esl.listing_to_item(
            {"ebay_item_id": "1", "title": "T", "thumbnail_url": "https://x/y.jpg"}
        )
        self.assertEqual(item["id"], "1")
        self.assertEqual(item["images"], ["https://x/y.jpg"])


class RerankRowsTest(unittest.TestCase):
    def _match(self, sim=0.9, **over):
        base = {
            "item_id": "lot-1",
            "ebay_item_id": "111222333444",
            "similarity": sim,
            "title": "Comparable chair",
            "sold_price": 250.0,
            "sold_date": "2026-05-05",
            "sold_date_label": "Sold May 5, 2026",
            "condition": "Used",
            "thumbnail_url": "https://i.ebayimg.com/t.jpg",
            "item_web_url": "https://www.ebay.com/itm/111222333444",
        }
        base.update(over)
        return base

    def test_shapes_hybrid_comp_rows(self):
        rows = esl.rerank_rows_for_auction(
            [self._match()], "auction-1", "2026-06-14T00:00:00+00:00"
        )
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["auction_safe_id"], "auction-1")
        self.assertEqual(row["item_id"], "lot-1")
        self.assertEqual(row["source_query"], "hybrid")
        self.assertEqual(row["price_value"], 250.0)
        self.assertEqual(row["item_web_url"], "https://www.ebay.com/itm/111222333444")

    def test_similarity_buckets_into_confidence(self):
        high = esl.rerank_rows_for_auction([self._match(sim=0.88)], "a", "t")[0]
        med = esl.rerank_rows_for_auction([self._match(sim=0.81)], "a", "t")[0]
        self.assertEqual(high["match_confidence"], "high")
        self.assertEqual(med["match_confidence"], "medium")

    def test_drops_matches_without_a_listing_url(self):
        rows = esl.rerank_rows_for_auction([self._match(item_web_url="")], "a", "t")
        self.assertEqual(rows, [])


if __name__ == "__main__":
    unittest.main()
