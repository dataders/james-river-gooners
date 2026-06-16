import base64
import os
import unittest
from unittest.mock import MagicMock, patch

import ebay_taxonomy as et

# Minimal synthetic category tree for testing tree-fetch + flatten logic.
_SAMPLE_TREE = {
    "rootCategoryNode": {
        "childCategoryTreeNodes": [
            {
                "category": {"categoryId": "550", "categoryName": "Art"},
                "childCategoryTreeNodes": [
                    {
                        "category": {
                            "categoryId": "11890",
                            "categoryName": "Paintings",
                        },
                        "childCategoryTreeNodes": [],
                    },
                    {
                        "category": {
                            "categoryId": "13193",
                            "categoryName": "Art Prints",
                        },
                        "childCategoryTreeNodes": [],
                    },
                ],
            },
            {
                "category": {"categoryId": "870", "categoryName": "Pottery & Glass"},
                "childCategoryTreeNodes": [
                    {
                        "category": {
                            "categoryId": "110107",
                            "categoryName": "Art Glass",
                        },
                        "childCategoryTreeNodes": [
                            {
                                "category": {
                                    "categoryId": "110108",
                                    "categoryName": "Blown Glass",
                                },
                                "childCategoryTreeNodes": [],
                            },
                        ],
                    },
                ],
            },
        ]
    }
}


def _mock_tree_response():
    mock = MagicMock()
    mock.status_code = 200
    mock.json.return_value = _SAMPLE_TREE
    mock.raise_for_status = lambda: None
    return mock


class FetchCategoryTreeTest(unittest.TestCase):
    def _fetch(self):
        with patch("requests.get", return_value=_mock_tree_response()):
            return et.fetch_category_tree("tok123")

    def test_flattens_all_nodes(self):
        rows = self._fetch()
        by_id = {r["category_id"]: r for r in rows}
        self.assertEqual(
            set(by_id), {"550", "11890", "13193", "870", "110107", "110108"}
        )

    def test_leaf_flag(self):
        rows = self._fetch()
        by_id = {r["category_id"]: r for r in rows}
        # nodes with children are not leaves
        self.assertFalse(by_id["550"]["leaf"])
        self.assertFalse(by_id["870"]["leaf"])
        self.assertFalse(by_id["110107"]["leaf"])
        # terminal nodes are leaves
        self.assertTrue(by_id["11890"]["leaf"])
        self.assertTrue(by_id["13193"]["leaf"])
        self.assertTrue(by_id["110108"]["leaf"])

    def test_full_path_built_from_ancestors(self):
        rows = self._fetch()
        by_id = {r["category_id"]: r for r in rows}
        self.assertEqual(by_id["550"]["full_path"], "Art")
        self.assertEqual(by_id["11890"]["full_path"], "Art > Paintings")
        self.assertEqual(
            by_id["110108"]["full_path"], "Pottery & Glass > Art Glass > Blown Glass"
        )

    def test_parent_id(self):
        rows = self._fetch()
        by_id = {r["category_id"]: r for r in rows}
        self.assertIsNone(by_id["550"]["parent_id"])
        self.assertEqual(by_id["11890"]["parent_id"], "550")
        self.assertEqual(by_id["110107"]["parent_id"], "870")
        self.assertEqual(by_id["110108"]["parent_id"], "110107")

    def test_level(self):
        rows = self._fetch()
        by_id = {r["category_id"]: r for r in rows}
        self.assertEqual(by_id["550"]["level"], 0)
        self.assertEqual(by_id["11890"]["level"], 1)
        self.assertEqual(by_id["110108"]["level"], 2)

    def test_skips_nodes_with_missing_id_or_name(self):
        tree = {
            "rootCategoryNode": {
                "childCategoryTreeNodes": [
                    {"category": {}, "childCategoryTreeNodes": []},
                    {
                        "category": {"categoryId": "550", "categoryName": "Art"},
                        "childCategoryTreeNodes": [],
                    },
                ]
            }
        }
        with patch(
            "requests.get",
            return_value=MagicMock(
                status_code=200,
                json=lambda: tree,
                raise_for_status=lambda: None,
            ),
        ):
            rows = et.fetch_category_tree("tok")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["category_id"], "550")


class MintTokenTest(unittest.TestCase):
    def test_sends_basic_auth_and_client_credentials(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "access_token": "tok_abc",
            "token_type": "Application Access Token",
        }
        mock_resp.raise_for_status = lambda: None

        with patch("requests.post", return_value=mock_resp) as mock_post:
            token = et.mint_token("my_id", "my_secret")

        self.assertEqual(token, "tok_abc")
        _, kwargs = mock_post.call_args
        expected_creds = base64.b64encode(b"my_id:my_secret").decode()
        self.assertIn(f"Basic {expected_creds}", kwargs["headers"]["Authorization"])
        self.assertEqual(kwargs["data"]["grant_type"], "client_credentials")
        self.assertIn("api_scope", kwargs["data"]["scope"])


class LeafCategoriesEnabledTest(unittest.TestCase):
    def test_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(et.leaf_categories_enabled())

    def test_on_for_truthy_values(self):
        for val in ("1", "true", "True"):
            with patch.dict(
                os.environ, {"GOONERS_EBAY_LEAF_CATEGORIES": val}, clear=True
            ):
                self.assertTrue(et.leaf_categories_enabled())

    def test_off_for_other_values(self):
        with patch.dict(os.environ, {"GOONERS_EBAY_LEAF_CATEGORIES": "0"}, clear=True):
            self.assertFalse(et.leaf_categories_enabled())


class ScorePathTest(unittest.TestCase):
    def test_matching_tokens_score_positive(self):
        score = et._score_path(
            "Pottery & Glass > Roseville Pottery", "Roseville pottery vase"
        )
        self.assertGreater(score, 0.0)

    def test_no_matching_tokens_scores_zero(self):
        self.assertEqual(
            et._score_path("Art > Paintings", "Roseville pottery vase"), 0.0
        )

    def test_empty_product_type_scores_zero(self):
        self.assertEqual(et._score_path("Art > Paintings", ""), 0.0)

    def test_short_tokens_ignored(self):
        # "a", "of", "the" have <= 3 chars and should not contribute
        self.assertEqual(et._score_path("Art > Paintings", "a of the"), 0.0)

    def test_case_insensitive(self):
        score = et._score_path("Art > Paintings", "PAINTINGS")
        self.assertGreater(score, 0.0)

    def test_length_weighting_favors_the_more_specific_token(self):
        # "casserole dish": the specific token ("casserole", 9 chars) should
        # outweigh the generic one ("dish", 4), so a Casseroles leaf scores
        # higher than a Dishes leaf for the same productType.
        casseroles = et._score_path(
            "Pottery & Glass > Decorative Cookware, Dinnerware & Serveware > Casseroles",
            "casserole dish",
        )
        dishes = et._score_path(
            "Pottery & Glass > Decorative Cookware, Dinnerware & Serveware > Dishes",
            "casserole dish",
        )
        self.assertGreater(casseroles, dishes)


class BestLeafFromCandidatesTest(unittest.TestCase):
    _CANDIDATES = [
        {"category_id": "11890", "full_path": "Art > Paintings"},
        {"category_id": "13193", "full_path": "Art > Art Prints"},
        {"category_id": "99999", "full_path": "Art > Sculptures"},
    ]

    def test_returns_best_matching_id(self):
        result = et.best_leaf_from_candidates(self._CANDIDATES, "painting oil canvas")
        self.assertEqual(result, "11890")

    def test_returns_empty_when_no_token_matches(self):
        result = et.best_leaf_from_candidates(
            self._CANDIDATES, "Roseville pottery vase"
        )
        self.assertEqual(result, "")

    def test_returns_empty_with_no_product_type(self):
        self.assertEqual(et.best_leaf_from_candidates(self._CANDIDATES, ""), "")

    def test_returns_empty_with_empty_candidates(self):
        self.assertEqual(et.best_leaf_from_candidates([], "painting"), "")

    def test_returns_empty_when_only_short_tokens(self):
        self.assertEqual(et.best_leaf_from_candidates(self._CANDIDATES, "an in"), "")

    def test_casserole_dish_prefers_vintage_casseroles_leaf(self):
        # The Corning Ware regression: "casserole dish" must land on the
        # Pottery & Glass Casseroles leaf, not the Dishes leaf and not the
        # modern Home & Garden "Casserole Pans" leaf. Length-weighting breaks
        # the casserole/dish overlap; priority order (Pottery & Glass first)
        # breaks the Casseroles-vs-Casserole-Pans tie.
        candidates = [
            {
                "category_id": "262369",
                "full_path": "Pottery & Glass > Decorative Cookware, Dinnerware & Serveware > Casseroles",
            },
            {
                "category_id": "262374",
                "full_path": "Pottery & Glass > Decorative Cookware, Dinnerware & Serveware > Dishes",
            },
            {
                "category_id": "98844",
                "full_path": "Home & Garden > Kitchen, Dining & Bar > Cookware > Casserole Pans",
            },
        ]
        self.assertEqual(
            et.best_leaf_from_candidates(candidates, "casserole dish"), "262369"
        )


class GroupToL1NamesTest(unittest.TestCase):
    def test_kitchenware_group_reaches_pottery_and_glass_first(self):
        names = et._GROUP_TO_L1_NAMES["Home & Kitchen"]
        # Estate kitchenware skews vintage, so Pottery & Glass leads and the
        # modern Home & Garden subtree is only the fallback.
        self.assertEqual(names[0], "Pottery & Glass")
        self.assertIn("Home & Garden", names)

    def test_legacy_single_subtree_groups_unchanged(self):
        self.assertEqual(et._GROUP_TO_L1_NAMES["Art"], ["Art"])
        self.assertEqual(et._GROUP_TO_L1_NAMES["China & Glass"], ["Pottery & Glass"])


class FetchLeafCandidatesOrderTest(unittest.TestCase):
    def test_subtrees_queried_in_priority_order_and_concatenated(self):
        rows_by_like = {
            "like.Pottery & Glass%": [
                {"category_id": "PG", "full_path": "Pottery & Glass > X"}
            ],
            "like.Collectibles%": [
                {"category_id": "CO", "full_path": "Collectibles > Y"}
            ],
            "like.Home & Garden%": [
                {"category_id": "HG", "full_path": "Home & Garden > Z"}
            ],
        }
        calls = []

        def fake_get(endpoint, headers=None, params=None, timeout=None):
            like = params["full_path"]
            calls.append(like)
            return MagicMock(status_code=200, json=lambda: rows_by_like[like])

        with patch("requests.get", side_effect=fake_get):
            out = et._fetch_leaf_candidates(
                "Home & Kitchen", "https://x.supabase.co", "sb_secret_x"
            )

        self.assertEqual(
            calls,
            ["like.Pottery & Glass%", "like.Collectibles%", "like.Home & Garden%"],
        )
        self.assertEqual([c["category_id"] for c in out], ["PG", "CO", "HG"])

    def test_one_failing_subtree_does_not_sink_the_rest(self):
        def fake_get(endpoint, headers=None, params=None, timeout=None):
            like = params["full_path"]
            if like == "like.Pottery & Glass%":
                return MagicMock(status_code=500, json=lambda: None)
            if like == "like.Home & Garden%":
                return MagicMock(
                    status_code=200,
                    json=lambda: [
                        {"category_id": "HG", "full_path": "Home & Garden > Z"}
                    ],
                )
            return MagicMock(status_code=200, json=lambda: [])  # Collectibles: empty

        with patch("requests.get", side_effect=fake_get):
            out = et._fetch_leaf_candidates(
                "Home & Kitchen", "https://x.supabase.co", "sb_secret_x"
            )

        self.assertEqual([c["category_id"] for c in out], ["HG"])


class LoadLeafCandidatesByGroupTest(unittest.TestCase):
    def _leaf_resp(self, data):
        mock = MagicMock()
        mock.status_code = 200
        mock.json.return_value = data
        return mock

    def test_returns_empty_dict_without_credentials(self):
        with patch.dict(os.environ, {}, clear=True):
            result = et.load_leaf_candidates_by_group({"Art"})
        self.assertEqual(result, {})

    def test_one_query_per_group(self):
        with patch("requests.get", return_value=self._leaf_resp([])) as mock_get:
            with patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "https://x.supabase.co",
                    "SUPABASE_SECRET_KEY": "sb_secret_x",
                },
                clear=True,
            ):
                result = et.load_leaf_candidates_by_group({"Art", "China & Glass"})

        self.assertEqual(mock_get.call_count, 2)
        self.assertIn("Art", result)
        self.assertIn("China & Glass", result)

    def test_unmapped_group_returns_empty_list_without_http(self):
        with patch("requests.get") as mock_get:
            with patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "https://x.supabase.co",
                    "SUPABASE_SECRET_KEY": "sb_secret_x",
                },
                clear=True,
            ):
                result = et.load_leaf_candidates_by_group({"Vehicles"})

        # "Vehicles" → no L1 name mapping → no HTTP call made
        mock_get.assert_not_called()
        self.assertEqual(result.get("Vehicles"), [])

    def test_supabase_error_returns_empty_list(self):
        bad_resp = MagicMock(status_code=500)
        with patch("requests.get", return_value=bad_resp):
            with patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "https://x.supabase.co",
                    "SUPABASE_SECRET_KEY": "sb_secret_x",
                },
                clear=True,
            ):
                result = et.load_leaf_candidates_by_group({"Art"})

        self.assertEqual(result["Art"], [])


if __name__ == "__main__":
    unittest.main()
