import json
import unittest
from unittest.mock import MagicMock

import supabase_facebook


class SupabaseFacebookRowsTest(unittest.TestCase):
    def test_build_rows_dedupes_by_listing_id(self):
        rows = supabase_facebook.build_facebook_sold_rows(
            [
                {"id": "1", "title": "Old", "listing_url": "https://fb/1"},
                {"id": "1", "title": "New", "listing_url": "https://fb/1"},
                {"id": "", "title": "Missing"},
            ]
        )

        self.assertEqual(
            rows, [{"id": "1", "title": "New", "listing_url": "https://fb/1"}]
        )

    def test_upsert_posts_json_with_merge_duplicates(self):
        session = MagicMock()
        session.post.return_value = MagicMock(ok=True, status_code=201)

        written = supabase_facebook.upsert_facebook_sold_listings(
            [{"id": "1", "title": "Ping"}],
            url="https://x.sb.co",
            key="sb_secret_x",
            session=session,
        )

        self.assertEqual(written, 1)
        args, kwargs = session.post.call_args
        self.assertEqual(args[0], "https://x.sb.co/rest/v1/facebook_sold_listings")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")
        self.assertIn("merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(json.loads(kwargs["data"])[0]["id"], "1")


if __name__ == "__main__":
    unittest.main()
