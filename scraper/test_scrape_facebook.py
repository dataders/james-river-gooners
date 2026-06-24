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
        # Current Apify schema: marketplace_listing_title + flat primary_listing_photo.uri
        card = {
            "id": "123",
            "listingUrl": "https://www.facebook.com/marketplace/item/123/",
            "marketplace_listing_title": "Ping G425 Driver",
            "listing_price": {"amount": "185", "formatted_amount": "$185"},
            "primary_listing_photo": {"uri": "https://img.test/ping.jpg"},
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

    def test_maps_apify_card_old_schema(self):
        # Old Apify schema backward compat: title + nested primary_listing_photo.image.uri
        card = {
            "id": "124",
            "listingUrl": "https://www.facebook.com/marketplace/item/124/",
            "title": "Callaway Irons",
            "listing_price": {"amount": "250", "formatted_amount": "$250"},
            "primary_listing_photo": {"image": {"uri": "https://img.test/callaway.jpg"}},
        }

        item = scrape_facebook.card_to_item(card)

        self.assertEqual(item["title"], "Callaway Irons")
        self.assertEqual(item["images"], ["https://img.test/callaway.jpg"])

    def test_maps_apify_card_to_sold_row(self):
        card = {
            "id": "sold-1",
            "listingUrl": "https://www.facebook.com/marketplace/item/sold-1/",
            "marketplace_listing_title": "Titleist Irons",
            "listing_price": {"amount": 425, "formatted_amount": "$425"},
            "primary_listing_photo": {"uri": "https://img.test/titleist.jpg"},
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

    def test_scrape_spec_writes_facebook_location_metadata(self):
        active_card = {
            "id": "active-1",
            "listingUrl": "https://www.facebook.com/marketplace/item/active-1/",
            "title": "Ping Driver",
            "listing_price": {"amount": 100, "formatted_amount": "$100"},
        }
        spec = {
            "keyword": "golf",
            "location": "richmond",
            "safe_id": "facebook_golf",
            "active_url": "https://facebook.test/active",
            "sold_url": "https://facebook.test/sold",
        }

        with (
            patch.object(
                scrape_facebook,
                "run_apify_urls",
                side_effect=[[active_card], []],
            ),
            patch.object(scrape_facebook, "write_read_model") as write_read_model,
        ):
            summary = scrape_facebook.scrape_spec(spec, api_token="token", limit=1)

        self.assertEqual(summary, {"active": 1, "sold": 0})
        ctx = write_read_model.call_args.args[1]
        self.assertEqual(ctx.auction_city, "Richmond")
        self.assertEqual(ctx.auction_state, "VA")

    def test_run_apify_urls_starts_actor_and_fetches_dataset(self):
        start_response = MagicMock()
        start_response.json.return_value = {
            "data": {"id": "run-1", "defaultDatasetId": "dataset-1"}
        }
        start_response.raise_for_status.return_value = None

        status_response = MagicMock()
        status_response.json.return_value = {"data": {"status": "SUCCEEDED"}}
        status_response.raise_for_status.return_value = None

        dataset_response = MagicMock()
        dataset_response.json.return_value = [{"id": "listing-1"}]
        dataset_response.raise_for_status.return_value = None

        with (
            patch.object(
                scrape_facebook.requests, "post", return_value=start_response
            ) as post,
            patch.object(
                scrape_facebook.requests,
                "get",
                side_effect=[status_response, dataset_response],
            ) as get,
        ):
            rows = scrape_facebook.run_apify_urls(
                "token",
                ["https://facebook.test/search"],
                limit=1,
                poll_interval=0,
            )

        _, kwargs = post.call_args
        self.assertTrue(
            post.call_args.args[0].endswith(
                "/acts/apify~facebook-marketplace-scraper/runs"
            )
        )
        self.assertEqual(
            kwargs["json"]["startUrls"],
            [{"url": "https://facebook.test/search"}],
        )
        self.assertNotIn("urls", kwargs["json"])
        self.assertEqual(kwargs["json"]["resultsLimit"], 1)
        self.assertNotIn("maxItems", kwargs["json"])
        self.assertNotIn("maxListings", kwargs["json"])
        self.assertEqual(
            get.call_args_list[0].args[0],
            "https://api.apify.com/v2/actor-runs/run-1",
        )
        self.assertEqual(
            get.call_args_list[1].args[0],
            "https://api.apify.com/v2/datasets/dataset-1/items",
        )
        self.assertEqual(rows, [{"id": "listing-1"}])

    def test_run_apify_urls_raises_when_actor_does_not_succeed(self):
        start_response = MagicMock()
        start_response.json.return_value = {
            "data": {"id": "run-1", "defaultDatasetId": "dataset-1"}
        }
        start_response.raise_for_status.return_value = None
        status_response = MagicMock()
        status_response.json.return_value = {"data": {"status": "FAILED"}}
        status_response.raise_for_status.return_value = None

        with (
            patch.object(scrape_facebook.requests, "post", return_value=start_response),
            patch.object(scrape_facebook.requests, "get", return_value=status_response),
        ):
            with self.assertRaisesRegex(
                RuntimeError, "Apify run run-1 ended with FAILED"
            ):
                scrape_facebook.run_apify_urls(
                    "token",
                    ["https://facebook.test/search"],
                    limit=1,
                    poll_interval=0,
                )


if __name__ == "__main__":
    unittest.main()
