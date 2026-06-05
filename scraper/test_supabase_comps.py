import json
import os
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from unittest.mock import patch

import supabase_comps


class JsonSafeTest(unittest.TestCase):
    def test_aware_datetime_kept_utc(self):
        dt = datetime(2026, 6, 5, 12, 30, tzinfo=timezone.utc)
        self.assertEqual(supabase_comps.json_safe(dt), "2026-06-05T12:30:00+00:00")

    def test_naive_datetime_assumed_utc(self):
        dt = datetime(2026, 6, 5, 12, 30)
        self.assertEqual(supabase_comps.json_safe(dt), "2026-06-05T12:30:00+00:00")

    def test_date_isoformat(self):
        self.assertEqual(supabase_comps.json_safe(date(2026, 6, 5)), "2026-06-05")

    def test_decimal_to_float(self):
        self.assertEqual(supabase_comps.json_safe(Decimal("12.50")), 12.5)

    def test_passthrough(self):
        self.assertEqual(supabase_comps.json_safe("x"), "x")
        self.assertIsNone(supabase_comps.json_safe(None))


class RowPayloadTest(unittest.TestCase):
    def test_only_table_columns_and_json_safe(self):
        row = {
            "auction_safe_id": "a1",
            "item_id": "i1",
            "price_value": Decimal("99.99"),
            "fetched_at": datetime(2026, 6, 5, tzinfo=timezone.utc),
            "lot_number": 7,
            "not_a_column": "dropped",
        }
        payload = supabase_comps.row_payload(row)
        self.assertNotIn("not_a_column", payload)
        self.assertNotIn("id", payload)
        self.assertNotIn("ingested_at", payload)
        self.assertEqual(set(payload), set(supabase_comps.COMP_COLUMNS))
        self.assertEqual(payload["price_value"], 99.99)
        self.assertEqual(payload["fetched_at"], "2026-06-05T00:00:00+00:00")
        self.assertIsNone(payload["title"])
        # The whole payload must be JSON-serializable for PostgREST.
        json.dumps(payload)


class ResolveCredentialsTest(unittest.TestCase):
    def test_args_win(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                supabase_comps.resolve_credentials("u", "k"), ("u", "k")
            )

    def test_falls_back_to_vite_url(self):
        with patch.dict(
            os.environ,
            {"VITE_SUPABASE_URL": "https://x.supabase.co", "SUPABASE_SECRET_KEY": "s"},
            clear=True,
        ):
            self.assertEqual(
                supabase_comps.resolve_credentials(),
                ("https://x.supabase.co", "s"),
            )


class AppendTest(unittest.TestCase):
    def test_empty_rows_no_request(self):
        session = unittest.mock.MagicMock()
        self.assertEqual(
            supabase_comps.append_ebay_comp_snapshots([], "u", "k", session=session), 0
        )
        session.post.assert_not_called()

    def test_missing_credentials_raise(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL"):
                supabase_comps.append_ebay_comp_snapshots([{"item_id": "i"}])
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_SECRET_KEY"):
                supabase_comps.append_ebay_comp_snapshots(
                    [{"item_id": "i"}], url="https://x.supabase.co"
                )

    def test_posts_batches_with_auth_headers(self):
        session = unittest.mock.MagicMock()
        response = unittest.mock.MagicMock(status_code=201)
        session.post.return_value = response
        rows = [{"item_id": f"i{n}", "price_value": Decimal("1.00")} for n in range(3)]

        written = supabase_comps.append_ebay_comp_snapshots(
            rows, url="https://x.supabase.co/", key="sb_secret_x",
            session=session, batch_size=2,
        )

        self.assertEqual(written, 3)
        self.assertEqual(session.post.call_count, 2)  # 2 + 1
        args, kwargs = session.post.call_args_list[0]
        self.assertEqual(args[0], "https://x.supabase.co/rest/v1/ebay_comp_snapshots")
        self.assertEqual(kwargs["headers"]["apikey"], "sb_secret_x")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")
        body = json.loads(kwargs["data"])
        self.assertEqual(len(body), 2)
        self.assertEqual(body[0]["price_value"], 1.0)

    def test_http_error_raises(self):
        session = unittest.mock.MagicMock()
        session.post.return_value = unittest.mock.MagicMock(
            status_code=400, text="bad request"
        )
        with self.assertRaisesRegex(RuntimeError, "Supabase comp insert failed"):
            supabase_comps.append_ebay_comp_snapshots(
                [{"item_id": "i"}], url="https://x.supabase.co", key="k", session=session
            )


if __name__ == "__main__":
    unittest.main()
