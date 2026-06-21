import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import scrape_facebook


class FacebookDiscoveryTest(unittest.TestCase):
    def test_discover_specs_expands_active_and_sold_urls(self):
        path = Path(__file__).resolve().parent / "facebook_sources.yml"
        specs = scrape_facebook.discover_facebook_specs(path)

        self.assertEqual(len(specs), 1)
        spec = specs[0]
        self.assertEqual(spec["keyword"], "golf")
        self.assertEqual(spec["safe_id"], "facebook_golf")
        self.assertEqual(
            spec["active_url"],
            "https://www.facebook.com/marketplace/richmond/search?query=golf&exact=true",
        )
        self.assertEqual(
            spec["sold_url"],
            "https://www.facebook.com/marketplace/richmond/search?availability=out%20of%20stock&query=golf&exact=true",
        )

    def test_safe_id_sanitizes_keyword(self):
        self.assertEqual(
            scrape_facebook.facebook_safe_id("Golf Clubs"), "facebook_golf_clubs"
        )


class FacebookMappingTest(unittest.TestCase):
    def test_maps_apify_card_to_shared_item(self):
        card = {
            "id": "123",
            "listingUrl": "https://www.facebook.com/marketplace/item/123/",
            "title": "Ping G425 Driver",
            "listing_price": {"amount": "185", "formatted_amount": "$185"},
            "primary_listing_photo": {"image": {"uri": "https://img.test/ping.jpg"}},
            "location": {"reverse_geocode": {"city": "Richmond"}},
        }

        item = scrape_facebook.card_to_item(card)

        self.assertEqual(item["id"], "123")
        self.assertEqual(item["title"], "Ping G425 Driver")
        self.assertEqual(item["currentBid"], 185.0)
        self.assertEqual(item["images"], ["https://img.test/ping.jpg"])
        self.assertEqual(
            item["detailUrl"], "https://www.facebook.com/marketplace/item/123/"
        )
        self.assertEqual(item["category"], "Facebook Marketplace")
        self.assertIsNone(item.get("endDate"))
        self.assertNotIn("totalBids", item)

    def test_maps_apify_card_to_sold_row(self):
        card = {
            "id": "sold-1",
            "listingUrl": "https://www.facebook.com/marketplace/item/sold-1/",
            "title": "Titleist Irons",
            "listing_price": {"amount": 425, "formatted_amount": "$425"},
            "primary_listing_photo": {
                "image": {"uri": "https://img.test/titleist.jpg"}
            },
            "location": {"name": "Richmond, VA"},
        }

        row = scrape_facebook.card_to_sold_listing_row(card, keyword="golf")

        self.assertEqual(row["id"], "sold-1")
        self.assertEqual(row["keyword"], "golf")
        self.assertEqual(row["title"], "Titleist Irons")
        self.assertEqual(row["price_value"], 425.0)
        self.assertEqual(row["price_label"], "$425")
        self.assertEqual(row["thumbnail_url"], "https://img.test/titleist.jpg")
        self.assertEqual(
            row["listing_url"], "https://www.facebook.com/marketplace/item/sold-1/"
        )
        self.assertEqual(row["location"], "Richmond, VA")

    def test_run_apify_urls_uses_actor_start_urls_input(self):
        response = MagicMock()
        response.json.return_value = []
        response.raise_for_status.return_value = None
        with patch.object(
            scrape_facebook.requests, "post", return_value=response
        ) as post:
            scrape_facebook.run_apify_urls(
                "token", ["https://facebook.test/search"], limit=1
            )

        _, kwargs = post.call_args
        self.assertEqual(
            kwargs["json"]["startUrls"],
            [{"url": "https://facebook.test/search"}],
        )
        self.assertNotIn("urls", kwargs["json"])


if __name__ == "__main__":
    unittest.main()
