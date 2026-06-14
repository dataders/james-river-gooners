import json
import os
import unittest
from datetime import date, datetime, UTC
from decimal import Decimal
from unittest.mock import patch

import supabase_comps


class JsonSafeTest(unittest.TestCase):
    def test_aware_datetime_kept_utc(self):
        dt = datetime(2026, 6, 5, 12, 30, tzinfo=UTC)
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
            "fetched_at": datetime(2026, 6, 5, tzinfo=UTC),
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
        with patch("supabase_comps.time.sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "Supabase comp insert failed"):
                supabase_comps.append_ebay_comp_snapshots(
                    [{"item_id": "i"}], url="https://x.supabase.co", key="k", session=session
                )
        # 4xx is permanent — no retry, no backoff.
        self.assertEqual(session.post.call_count, 1)
        sleep.assert_not_called()

    def test_transient_error_retried_then_succeeds(self):
        session = unittest.mock.MagicMock()
        session.post.side_effect = [
            unittest.mock.MagicMock(status_code=503, text="PGRST002 schema cache"),
            unittest.mock.MagicMock(status_code=201),
        ]
        with patch("supabase_comps.time.sleep") as sleep:
            written = supabase_comps.append_ebay_comp_snapshots(
                [{"item_id": "i"}], url="https://x.supabase.co", key="k", session=session
            )
        self.assertEqual(written, 1)
        self.assertEqual(session.post.call_count, 2)
        sleep.assert_called_once_with(2)

    def test_network_error_retried_then_succeeds(self):
        import requests

        session = unittest.mock.MagicMock()
        session.post.side_effect = [
            requests.exceptions.ConnectionError("reset"),
            unittest.mock.MagicMock(status_code=201),
        ]
        with patch("supabase_comps.time.sleep"):
            written = supabase_comps.append_ebay_comp_snapshots(
                [{"item_id": "i"}], url="https://x.supabase.co", key="k", session=session
            )
        self.assertEqual(written, 1)
        self.assertEqual(session.post.call_count, 2)


class ContentRangeTotalTest(unittest.TestCase):
    def test_parses_total(self):
        self.assertEqual(supabase_comps.content_range_total("0-24/137"), 137)

    def test_unknown_or_missing_is_zero(self):
        self.assertEqual(supabase_comps.content_range_total("*/*"), 0)
        self.assertEqual(supabase_comps.content_range_total(None), 0)
        self.assertEqual(supabase_comps.content_range_total(""), 0)


class SupabaseCompLedgerTest(unittest.TestCase):
    def _ledger(self, session):
        return supabase_comps.SupabaseCompLedger(
            url="https://x.supabase.co/", key="sb_secret_x", session=session
        )

    def test_missing_credentials_raise(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL"):
                supabase_comps.SupabaseCompLedger()
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_SECRET_KEY"):
                supabase_comps.SupabaseCompLedger(url="https://x.supabase.co")

    def test_fresh_keys_filters_by_cutoff(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200,
            json=lambda: [
                {"auction_safe_id": "A", "item_id": "1"},
                {"auction_safe_id": "A", "item_id": "2"},
            ],
        )
        ledger = self._ledger(session)
        now = datetime(2026, 6, 5, 12, 0, tzinfo=UTC)
        keys = ledger.fresh_keys(stale_hours=168, now=now)  # 7 days
        self.assertEqual(keys, {"A:1", "A:2"})
        _, kwargs = session.get.call_args
        self.assertEqual(
            kwargs["params"]["last_fetched_at"], "gte.2026-05-29T12:00:00+00:00"
        )
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")
        self.assertNotIn("Prefer", kwargs["headers"])  # not a count read

    def test_fresh_keys_skip_attempted_has_no_time_filter(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(status_code=200, json=lambda: [])
        self._ledger(session).fresh_keys(stale_hours=168, skip_attempted=True)
        _, kwargs = session.get.call_args
        self.assertNotIn("last_fetched_at", kwargs["params"])

    def test_fresh_keys_zero_stale_hours_skips_nothing_without_a_request(self):
        session = unittest.mock.MagicMock()
        self.assertEqual(self._ledger(session).fresh_keys(stale_hours=0), set())
        session.get.assert_not_called()

    def test_requests_used_in_month_counts_from_first_of_month(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200, headers={"Content-Range": "0-0/42"}
        )
        ledger = self._ledger(session)
        now = datetime(2026, 6, 5, 12, 30, tzinfo=UTC)
        self.assertEqual(ledger.requests_used_in_month(now), 42)
        _, kwargs = session.get.call_args
        self.assertEqual(kwargs["params"]["fetched_at"], "gte.2026-06-01T00:00:00+00:00")
        self.assertEqual(kwargs["headers"]["Prefer"], "count=exact")

    def test_requests_used_today_counts_from_midnight(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200, headers={"Content-Range": "0-0/5"}
        )
        ledger = self._ledger(session)
        now = datetime(2026, 6, 5, 12, 30, tzinfo=UTC)
        self.assertEqual(ledger.requests_used_today(now), 5)
        _, kwargs = session.get.call_args
        self.assertEqual(kwargs["params"]["fetched_at"], "gte.2026-06-05T00:00:00+00:00")

    def test_ledger_read_http_error_retries_then_raises(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(status_code=500, text="boom")
        with patch("supabase_comps.time.sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, "Supabase ledger read failed"):
                self._ledger(session).fresh_keys(stale_hours=168)
        # Transient 5xx is retried with backoff before giving up.
        self.assertEqual(session.get.call_count, supabase_comps.DEFAULT_MAX_RETRIES + 1)
        self.assertEqual(
            [call.args[0] for call in sleep.call_args_list], [2, 4, 8, 16]
        )

    def test_provider_remaining_reads_latest_reading(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200, json=lambda: [{"remaining": 1620}]
        )
        self.assertEqual(self._ledger(session).provider_remaining(), 1620)
        args, kwargs = session.get.call_args
        self.assertTrue(args[0].endswith("/soldcomps_usage"))
        self.assertEqual(kwargs["params"]["order"], "observed_at.desc")
        self.assertEqual(kwargs["params"]["limit"], "1")

    def test_provider_remaining_none_when_no_rows(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200, json=lambda: []
        )
        self.assertIsNone(self._ledger(session).provider_remaining())

    def test_provider_used_today_is_high_minus_latest(self):
        session = unittest.mock.MagicMock()
        # First call: latest remaining (order observed_at.desc). Second: day high.
        session.get.side_effect = [
            unittest.mock.MagicMock(status_code=200, json=lambda: [{"remaining": 1600}]),
            unittest.mock.MagicMock(status_code=200, json=lambda: [{"remaining": 1750}]),
        ]
        now = datetime(2026, 6, 14, 12, 0, tzinfo=UTC)
        self.assertEqual(self._ledger(session).provider_used_today(now), 150)
        _, kwargs = session.get.call_args  # the day-high read
        self.assertEqual(kwargs["params"]["observed_at"], "gte.2026-06-14T00:00:00+00:00")
        self.assertEqual(kwargs["params"]["order"], "remaining.desc")

    def test_provider_used_today_zero_when_no_reading(self):
        session = unittest.mock.MagicMock()
        session.get.return_value = unittest.mock.MagicMock(
            status_code=200, json=lambda: []
        )
        self.assertEqual(self._ledger(session).provider_used_today(), 0)

    def test_record_provider_remaining_posts_row(self):
        session = unittest.mock.MagicMock()
        session.post.return_value = unittest.mock.MagicMock(status_code=201)
        self._ledger(session).record_provider_remaining(1500)
        args, kwargs = session.post.call_args
        self.assertTrue(args[0].endswith("/soldcomps_usage"))
        self.assertEqual(json.loads(kwargs["data"]), {"remaining": 1500})
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")

    def test_ledger_read_transient_503_recovers(self):
        session = unittest.mock.MagicMock()
        session.get.side_effect = [
            unittest.mock.MagicMock(
                status_code=503, text='{"code":"PGRST002","message":"schema cache"}'
            ),
            unittest.mock.MagicMock(
                status_code=200, json=lambda: [{"auction_safe_id": "A", "item_id": "1"}]
            ),
        ]
        with patch("supabase_comps.time.sleep") as sleep:
            keys = self._ledger(session).fresh_keys(stale_hours=168)
        self.assertEqual(keys, {"A:1"})
        sleep.assert_called_once_with(2)


if __name__ == "__main__":
    unittest.main()
