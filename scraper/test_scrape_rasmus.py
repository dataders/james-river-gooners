import unittest
from unittest import mock

import scrape_rasmus
from scrape_rasmus import (
    _fs_fields,
    _fs_value,
    _richmond_specs_from_aids,
    city_state_from_title,
    has_bid_changes,
    location_matches,
    map_item,
    ms_to_iso,
    parse_rasmus_category,
    rasmus_safe_id,
)


class CityStateFromTitleTest(unittest.TestCase):
    KEYWORDS = [
        "VA",
        "Virginia",
        "Richmond",
        "Glen Allen",
        "Virginia Beach",
        "Newport News",
    ]

    def test_extracts_city_and_defaults_state(self):
        self.assertEqual(
            city_state_from_title("Estate Auction | Richmond, VA", self.KEYWORDS),
            ("Richmond", "VA"),
        )

    def test_prefers_longest_match(self):
        # "Virginia Beach" must win over the bare "Virginia"/"VA" tokens.
        self.assertEqual(
            city_state_from_title(
                "Coins & Collectibles - Virginia Beach, VA", self.KEYWORDS
            ),
            ("Virginia Beach", "VA"),
        )

    def test_multiword_city(self):
        self.assertEqual(
            city_state_from_title("Tools Auction Newport News VA", self.KEYWORDS),
            ("Newport News", "VA"),
        )

    def test_no_city_returns_blank_city(self):
        # Only the bare state token matched — no pinnable city, so the geocode
        # gate (downstream) fails the scrape rather than guessing.
        self.assertEqual(
            city_state_from_title("Surplus Auction in Virginia", self.KEYWORDS),
            ("", "VA"),
        )


class RichmondSpecsFromAidsTest(unittest.TestCase):
    KEYWORDS = ["richmond", "glen allen", "va"]

    def test_keeps_only_richmond_non_real_estate(self):
        metas = {
            "a": {
                "title": "Estate Auction Richmond VA",
                "description": "",
                "image": "imgA",
            },
            "b": {
                "title": "Furniture Sale Laurel MD",
                "description": "",
                "image": "imgB",
            },
            "c": {
                "title": "Land Auction Glen Allen VA",
                "description": "acres",
                "image": "imgC",
            },
        }
        with mock.patch.object(
            scrape_rasmus, "fetch_auction_meta", side_effect=lambda s, aid: metas[aid]
        ):
            specs = _richmond_specs_from_aids(
                mock.Mock(), ["a", "b", "c"], "rasmus", "Rasmus", self.KEYWORDS
            )

        # b is out (not Richmond), c is out (real estate); only a survives.
        self.assertEqual([s["aid"] for s in specs], ["a"])
        self.assertEqual(specs[0]["safe_id"], "rasmus_a")
        self.assertEqual(specs[0]["image"], "imgA")


class RasmusSafeIdTest(unittest.TestCase):
    def test_prefixes_aid(self):
        self.assertEqual(
            rasmus_safe_id("pf23czO6MUhD0MLWL3Du"), "rasmus_pf23czO6MUhD0MLWL3Du"
        )

    def test_prefix_prevents_collision(self):
        self.assertTrue(rasmus_safe_id("abc").startswith("rasmus_"))


class LocationMatchesTest(unittest.TestCase):
    KEYWORDS = ["Richmond", "Henrico", "Glen Allen", "Aylett"]

    def test_matches_city_in_title(self):
        self.assertTrue(location_matches("Brewery Auction Richmond, VA", self.KEYWORDS))

    def test_matches_multiword_place(self):
        self.assertTrue(location_matches("Estate Sale in Glen Allen VA", self.KEYWORDS))

    def test_case_insensitive(self):
        self.assertTrue(location_matches("located in AYLETT, virginia", self.KEYWORDS))

    def test_non_richmond_not_matched(self):
        self.assertFalse(
            location_matches("Appliances & Home Goods Laurel MD", self.KEYWORDS)
        )

    def test_whole_word_only(self):
        # "Richmondville" should not match "Richmond"
        self.assertFalse(location_matches("Richmondville NY Auction", self.KEYWORDS))

    def test_empty_text(self):
        self.assertFalse(location_matches("", self.KEYWORDS))


class ParseRasmusCategoryTest(unittest.TestCase):
    def test_standard_shape(self):
        self.assertEqual(parse_rasmus_category(["0--Category--China"]), "China")

    def test_nested_path_takes_leaf(self):
        self.assertEqual(
            parse_rasmus_category(["3--Category--Vehicles--Trucks"]), "Trucks"
        )

    def test_takes_first_of_multiple(self):
        self.assertEqual(
            parse_rasmus_category(["0--Category--Furniture", "1--Category--Antique"]),
            "Furniture",
        )

    def test_empty_list(self):
        self.assertEqual(parse_rasmus_category([]), "")

    def test_none(self):
        self.assertEqual(parse_rasmus_category(None), "")


class MsToIsoTest(unittest.TestCase):
    def test_converts_epoch_ms(self):
        # 1624825380000 ms = 2021-06-27T20:23:00+00:00
        self.assertEqual(ms_to_iso(1624825380000), "2021-06-27T20:23:00+00:00")

    def test_string_input(self):
        self.assertEqual(ms_to_iso("1624825380000"), "2021-06-27T20:23:00+00:00")

    def test_zero_returns_empty(self):
        self.assertEqual(ms_to_iso(0), "")

    def test_none_returns_empty(self):
        self.assertEqual(ms_to_iso(None), "")


class FirestoreValueTest(unittest.TestCase):
    def test_decodes_scalar_types(self):
        self.assertEqual(_fs_value({"stringValue": "x"}), "x")
        self.assertEqual(_fs_value({"integerValue": "42"}), 42)
        self.assertEqual(_fs_value({"doubleValue": 1.5}), 1.5)
        self.assertEqual(_fs_value({"booleanValue": True}), True)
        self.assertIsNone(_fs_value({"nullValue": None}))

    def test_decodes_array_and_map(self):
        arr = {"arrayValue": {"values": [{"stringValue": "a"}, {"stringValue": "b"}]}}
        self.assertEqual(_fs_value(arr), ["a", "b"])
        mp = {"mapValue": {"fields": {"k": {"integerValue": "1"}}}}
        self.assertEqual(_fs_value(mp), {"k": 1})

    def test_fs_fields(self):
        doc = {
            "fields": {"name": {"stringValue": "Chair"}, "lot": {"integerValue": "5"}}
        }
        self.assertEqual(_fs_fields(doc), {"name": "Chair", "lot": 5})


def _lot_doc(**overrides) -> dict:
    fields = {
        "iid": {"stringValue": "0001zxfoJl12GN2NEu24"},
        "lot": {"integerValue": "121"},
        "name": {"stringValue": "Colorful Fruit Plates"},
        "description": {"stringValue": "Six Different Plates."},
        "price": {"doubleValue": 1.1},
        "has_bids": {"booleanValue": True},
        "time_end": {"integerValue": "1624825380000"},
        "category": {"arrayValue": {"values": [{"stringValue": "0--Category--China"}]}},
        "bidders_by_uid": {
            "arrayValue": {
                "values": [
                    {"stringValue": "u1"},
                    {"stringValue": "u2"},
                    {"stringValue": "u3"},
                ]
            }
        },
        "photos_display": {
            "arrayValue": {
                "values": [
                    {
                        "mapValue": {
                            "fields": {
                                "src": {"stringValue": "https://img/121-0.jpg"},
                                "thumb": {"stringValue": "https://img/121-0-small.jpg"},
                            }
                        }
                    },
                ]
            }
        },
    }
    fields.update(overrides)
    return {
        "name": "projects/dark-shade/databases/(default)/documents/items/0001zxfoJl12GN2NEu24",
        "fields": fields,
    }


class MapItemTest(unittest.TestCase):
    def test_maps_core_fields(self):
        item = map_item(_lot_doc(), "ASdfsbPK6nsMUmU69NZM")
        assert item is not None
        self.assertEqual(item["id"], "rasmus_0001zxfoJl12GN2NEu24")
        self.assertEqual(item["lotNumber"], 121)
        self.assertEqual(item["title"], "Colorful Fruit Plates")
        self.assertEqual(item["currentBid"], 1.1)
        self.assertEqual(item["images"], ["https://img/121-0.jpg"])
        self.assertEqual(item["endDate"], "2021-06-27T20:23:00+00:00")
        self.assertEqual(
            item["detailUrl"],
            "https://rasmus.com/auctions/ASdfsbPK6nsMUmU69NZM/lot/121",
        )

    def test_unique_bidders_from_bidder_list(self):
        item = map_item(_lot_doc(), "aid")
        assert item is not None
        self.assertEqual(item["uniqueBidders"], 3)
        self.assertEqual(item["totalBids"], 3)

    def test_no_bids_zeroes_counts(self):
        doc = _lot_doc(
            has_bids={"booleanValue": False},
            bidders_by_uid={"arrayValue": {"values": []}},
        )
        item = map_item(doc, "aid")
        assert item is not None
        self.assertEqual(item["uniqueBidders"], 0)
        self.assertEqual(item["totalBids"], 0)

    def test_falls_back_to_doc_name_for_iid(self):
        doc = _lot_doc()
        del doc["fields"]["iid"]
        item = map_item(doc, "aid")
        assert item is not None
        self.assertEqual(item["id"], "rasmus_0001zxfoJl12GN2NEu24")

    def test_category_normalized(self):
        item = map_item(_lot_doc(), "aid")
        assert item is not None
        # raw "China" should survive into rawCategory; category is a broad group
        self.assertTrue(item["category"])
        self.assertTrue(item["rawCategory"])


class HasBidChangesTest(unittest.TestCase):
    def _items(self, bid, total):
        return [{"id": "rasmus_1", "currentBid": bid, "totalBids": total}]

    def test_no_existing_is_change(self):
        self.assertTrue(has_bid_changes(self._items(5, 1), {}))

    def test_same_bids_no_change(self):
        self.assertFalse(has_bid_changes(self._items(5, 1), {"rasmus_1": (5.0, 1)}))

    def test_price_change_detected(self):
        self.assertTrue(has_bid_changes(self._items(6, 1), {"rasmus_1": (5.0, 1)}))

    def test_new_item_detected(self):
        self.assertTrue(has_bid_changes(self._items(5, 1), {"rasmus_other": (5.0, 1)}))


if __name__ == "__main__":
    unittest.main()
