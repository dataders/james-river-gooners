import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import supabase_lots

# ---------------------------------------------------------------------------
# _lot_row — camelCase NDJSON → snake_case Supabase row
# ---------------------------------------------------------------------------

SAMPLE_ITEM = {
    "auctionSafeId": "abc_123",
    "id": "456",
    "lotNumber": 7,
    "title": "Silver Bowl",
    "description": "Pretty bowl",
    "currentBid": 42.5,
    "totalBids": 8,
    "uniqueBidders": 3,
    "endDate": "2026-06-10 6:00:00 PM",
    "images": ["https://img/a.jpg", "https://img/b.jpg"],
    "category": "Silver & Metal",
    "rawCategory": "Sterling",
    "detailUrl": "https://bid.cannons.com/item/456",
    "auctionId": "abc==",
    "auctionTitle": "06/10/26: Estate Sale",
    "auctionEndDate": "2026-06-10 7:00:00 PM",
    "scrapedAt": "2026-06-05T12:00:00+00:00",
    "source": "cannons",
}


class LotRowTest(unittest.TestCase):
    def test_maps_camel_to_snake_case(self):
        row = supabase_lots._lot_row(SAMPLE_ITEM)
        self.assertEqual(row["auction_safe_id"], "abc_123")
        self.assertEqual(row["item_id"], "456")
        self.assertEqual(row["lot_number"], 7)
        self.assertEqual(row["current_bid"], 42.5)
        self.assertEqual(row["total_bids"], 8)
        self.assertEqual(row["unique_bidders"], 3)
        self.assertEqual(row["raw_category"], "Sterling")
        self.assertEqual(row["detail_url"], "https://bid.cannons.com/item/456")
        self.assertEqual(row["auction_id"], "abc==")
        self.assertEqual(row["auction_title"], "06/10/26: Estate Sale")
        self.assertEqual(row["auction_end_date"], "2026-06-10 7:00:00 PM")
        self.assertEqual(row["source"], "cannons")

    def test_images_list_passed_through(self):
        row = supabase_lots._lot_row(SAMPLE_ITEM)
        self.assertEqual(row["images"], ["https://img/a.jpg", "https://img/b.jpg"])

    def test_parquet_stringified_images_parsed(self):
        item = {**SAMPLE_ITEM, "images": json.dumps(["https://img/x.jpg"])}
        row = supabase_lots._lot_row(item)
        self.assertEqual(row["images"], ["https://img/x.jpg"])

    def test_invalid_image_string_wrapped_in_list(self):
        item = {**SAMPLE_ITEM, "images": "not-json"}
        row = supabase_lots._lot_row(item)
        self.assertEqual(row["images"], ["not-json"])

    def test_empty_images_string_gives_empty_list(self):
        item = {**SAMPLE_ITEM, "images": ""}
        row = supabase_lots._lot_row(item)
        self.assertEqual(row["images"], [])

    def test_not_archived_by_default(self):
        row = supabase_lots._lot_row(SAMPLE_ITEM)
        self.assertFalse(row["archived"])
        self.assertNotIn("final_bid", row)
        self.assertNotIn("closed", row)

    def test_archived_flag_and_final_price(self):
        item = {**SAMPLE_ITEM, "finalBid": 120.0, "closed": True}
        row = supabase_lots._lot_row(item, archived=True)
        self.assertTrue(row["archived"])
        self.assertEqual(row["final_bid"], 120.0)
        self.assertTrue(row["closed"])

    def test_archived_unsold_has_none_final_bid(self):
        row = supabase_lots._lot_row(SAMPLE_ITEM, archived=True)
        self.assertIsNone(row["final_bid"])

    def test_non_numeric_current_bid_becomes_none(self):
        item = {**SAMPLE_ITEM, "currentBid": "n/a"}
        row = supabase_lots._lot_row(item)
        self.assertIsNone(row["current_bid"])

    def test_row_is_json_serializable(self):
        row = supabase_lots._lot_row(SAMPLE_ITEM, archived=True)
        json.dumps(row)


# ---------------------------------------------------------------------------
# upsert_lots
# ---------------------------------------------------------------------------


def _ok_session(status=201):
    session = MagicMock()
    session.post.return_value = MagicMock(ok=True, status_code=status)
    return session


class UpsertLotsTest(unittest.TestCase):
    def test_empty_items_no_request(self):
        session = _ok_session()
        result = supabase_lots.upsert_lots(
            [], "s", url="https://x.sb.co", key="k", session=session
        )
        self.assertEqual(result, 0)
        session.post.assert_not_called()

    def test_missing_credentials_returns_zero(self):
        with patch.dict(os.environ, {}, clear=True):
            result = supabase_lots.upsert_lots([SAMPLE_ITEM], "s")
        self.assertEqual(result, 0)

    def test_posts_to_lots_table_with_auth_header(self):
        session = _ok_session()
        items = [{"auctionSafeId": "s", "id": str(n)} for n in range(3)]
        written = supabase_lots.upsert_lots(
            items,
            "s",
            url="https://x.sb.co/",
            key="sb_secret_x",
            session=session,
            batch_size=2,
        )
        self.assertEqual(written, 3)
        self.assertEqual(session.post.call_count, 2)  # 2 + 1
        args, kwargs = session.post.call_args_list[0]
        self.assertEqual(args[0], "https://x.sb.co/rest/v1/lots")
        self.assertIn("merge-duplicates", kwargs["headers"]["Prefer"])
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer sb_secret_x")
        self.assertEqual(kwargs["headers"]["apikey"], "sb_secret_x")

    def test_batching_splits_correctly(self):
        session = _ok_session()
        items = [{"auctionSafeId": "s", "id": str(n)} for n in range(5)]
        supabase_lots.upsert_lots(
            items, "s", url="https://x.sb.co", key="k", session=session, batch_size=2
        )
        self.assertEqual(session.post.call_count, 3)  # 2 + 2 + 1

    def test_http_error_raises_with_status(self):
        session = MagicMock()
        session.post.return_value = MagicMock(
            ok=False, status_code=401, text="unauthorized"
        )
        with self.assertRaisesRegex(RuntimeError, "lots upsert failed.*401"):
            supabase_lots.upsert_lots(
                [SAMPLE_ITEM],
                "s",
                url="https://x.sb.co",
                key="k",
                session=session,
            )

    def test_500_error_includes_response_body(self):
        session = MagicMock()
        session.post.return_value = MagicMock(
            ok=False, status_code=500, text="internal server error"
        )
        with self.assertRaisesRegex(RuntimeError, "internal server error"):
            supabase_lots.upsert_lots(
                [SAMPLE_ITEM],
                "s",
                url="https://x.sb.co",
                key="k",
                session=session,
            )


# ---------------------------------------------------------------------------
# upsert_lots — skip-unchanged diff (#242)
# ---------------------------------------------------------------------------


def _session_with_existing(existing_rows, status=201):
    """Mock session whose GET returns stored rows and whose POST succeeds."""
    session = MagicMock()
    get_resp = MagicMock(ok=True, status_code=200)
    get_resp.json.return_value = existing_rows
    session.get.return_value = get_resp
    session.post.return_value = MagicMock(ok=True, status_code=status)
    return session


def _active_item(item_id, **over) -> dict:
    item = {
        "auctionSafeId": "s",
        "id": item_id,
        "currentBid": 10.0,
        "totalBids": 2,
        "uniqueBidders": 1,
        "endDate": "2026-06-10 6:00:00 PM",
    }
    item.update(over)
    return item


def _existing_row(item_id, **over) -> dict:
    # current_bid comes back from PostgREST as a numeric string ("10.00").
    row = {
        "item_id": item_id,
        "current_bid": "10.00",
        "total_bids": 2,
        "unique_bidders": 1,
        "end_date": "2026-06-10 6:00:00 PM",
    }
    row.update(over)
    return row


class SkipUnchangedTest(unittest.TestCase):
    def _posted_item_ids(self, session) -> set:
        ids: set = set()
        for _, kwargs in session.post.call_args_list:
            for row in kwargs["json"]:
                ids.add(row["item_id"])
        return ids

    def test_all_unchanged_skips_upsert(self):
        session = _session_with_existing([_existing_row("1"), _existing_row("2")])
        written = supabase_lots.upsert_lots(
            [_active_item("1"), _active_item("2")],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 0)
        session.post.assert_not_called()

    def test_numeric_string_roundtrip_is_not_a_change(self):
        # current_bid 10.0 vs stored "10.00" must not register as a change.
        session = _session_with_existing([_existing_row("1", current_bid="10.00")])
        written = supabase_lots.upsert_lots(
            [_active_item("1", currentBid=10.0)],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 0)
        session.post.assert_not_called()

    def test_changed_and_new_lots_are_upserted(self):
        existing = [_existing_row("1"), _existing_row("2")]
        session = _session_with_existing(existing)
        items = [
            _active_item("1"),  # unchanged → skipped
            _active_item("2", currentBid=25.0),  # bid changed → upserted
            _active_item("3"),  # brand new → upserted
        ]
        written = supabase_lots.upsert_lots(
            items,
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 2)
        self.assertEqual(self._posted_item_ids(session), {"2", "3"})

    def test_changed_total_bids_triggers_upsert(self):
        session = _session_with_existing([_existing_row("1")])
        written = supabase_lots.upsert_lots(
            [_active_item("1", totalBids=9)],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 1)
        self.assertEqual(self._posted_item_ids(session), {"1"})

    def test_changed_end_date_triggers_upsert(self):
        # Soft-close extension moves end_date — must re-upsert.
        session = _session_with_existing([_existing_row("1")])
        written = supabase_lots.upsert_lots(
            [_active_item("1", endDate="2026-06-10 6:05:00 PM")],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 1)

    def test_empty_existing_upserts_everything(self):
        # First scrape of an auction: nothing stored yet → upsert all.
        session = _session_with_existing([])
        written = supabase_lots.upsert_lots(
            [_active_item("1"), _active_item("2")],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
        )
        self.assertEqual(written, 2)
        self.assertEqual(self._posted_item_ids(session), {"1", "2"})

    def test_skip_unchanged_false_bypasses_diff(self):
        session = _ok_session()
        written = supabase_lots.upsert_lots(
            [_active_item("1")],
            "s",
            url="https://x.sb.co",
            key="k",
            session=session,
            skip_unchanged=False,
        )
        self.assertEqual(written, 1)
        session.get.assert_not_called()


# ---------------------------------------------------------------------------
# archive_lots
# ---------------------------------------------------------------------------


class ArchiveLotsTest(unittest.TestCase):
    def test_empty_items_no_request(self):
        session = _ok_session()
        result = supabase_lots.archive_lots(
            "s", [], url="https://x.sb.co", key="k", session=session
        )
        self.assertEqual(result, 0)
        session.post.assert_not_called()

    def test_sets_archived_true_and_final_bid(self):
        session = _ok_session()
        items = [{"auctionSafeId": "s", "id": "1", "finalBid": 75.0, "closed": True}]
        supabase_lots.archive_lots(
            "s", items, url="https://x.sb.co", key="k", session=session
        )
        _, kwargs = session.post.call_args
        row = kwargs["json"][0]
        self.assertTrue(row["archived"])
        self.assertEqual(row["final_bid"], 75.0)
        self.assertTrue(row["closed"])

    def test_archived_unsold_lot_has_none_final_bid(self):
        session = _ok_session()
        items = [{"auctionSafeId": "s", "id": "1", "currentBid": 0}]
        supabase_lots.archive_lots(
            "s", items, url="https://x.sb.co", key="k", session=session
        )
        _, kwargs = session.post.call_args
        self.assertIsNone(kwargs["json"][0]["final_bid"])

    def test_http_error_raises(self):
        session = MagicMock()
        session.post.return_value = MagicMock(ok=False, status_code=500, text="boom")
        with self.assertRaisesRegex(RuntimeError, "lots upsert failed"):
            supabase_lots.archive_lots(
                "s",
                [SAMPLE_ITEM],
                url="https://x.sb.co",
                key="k",
                session=session,
            )


# ---------------------------------------------------------------------------
# backfill
# ---------------------------------------------------------------------------


class BackfillTest(unittest.TestCase):
    def _write_ndjson(self, directory: Path, filename: str, items: list) -> None:
        (directory / filename).write_text(
            "\n".join(json.dumps(i) for i in items) + "\n",
            encoding="utf-8",
        )

    def test_reads_active_and_archived_ndjson(self):
        session = _ok_session()
        with tempfile.TemporaryDirectory() as tmp:
            active_dir = Path(tmp) / "items"
            active_dir.mkdir()
            archive_dir = Path(tmp) / "archive" / "items"
            archive_dir.mkdir(parents=True)

            self._write_ndjson(
                active_dir,
                "a1.ndjson",
                [
                    {"auctionSafeId": "a1", "id": "1"},
                    {"auctionSafeId": "a1", "id": "2"},
                ],
            )
            self._write_ndjson(
                archive_dir,
                "a2.ndjson",
                [
                    {"auctionSafeId": "a2", "id": "1", "finalBid": 50.0},
                ],
            )

            orig_active = supabase_lots.ITEMS_DIR
            orig_archive = supabase_lots.ARCHIVE_ITEMS_DIR
            supabase_lots.ITEMS_DIR = active_dir
            supabase_lots.ARCHIVE_ITEMS_DIR = archive_dir
            try:
                active, archived = supabase_lots.backfill(
                    url="https://x.sb.co",
                    key="k",
                    session=session,
                )
            finally:
                supabase_lots.ITEMS_DIR = orig_active
                supabase_lots.ARCHIVE_ITEMS_DIR = orig_archive

        self.assertEqual(active, 2)
        self.assertEqual(archived, 1)

    def test_active_only_skips_archive(self):
        session = _ok_session()
        with tempfile.TemporaryDirectory() as tmp:
            active_dir = Path(tmp) / "items"
            active_dir.mkdir()
            archive_dir = Path(tmp) / "archive" / "items"
            archive_dir.mkdir(parents=True)
            self._write_ndjson(
                active_dir, "a1.ndjson", [{"auctionSafeId": "a1", "id": "1"}]
            )
            self._write_ndjson(
                archive_dir, "a2.ndjson", [{"auctionSafeId": "a2", "id": "1"}]
            )

            orig_active = supabase_lots.ITEMS_DIR
            orig_archive = supabase_lots.ARCHIVE_ITEMS_DIR
            supabase_lots.ITEMS_DIR = active_dir
            supabase_lots.ARCHIVE_ITEMS_DIR = archive_dir
            try:
                active, archived = supabase_lots.backfill(
                    url="https://x.sb.co",
                    key="k",
                    session=session,
                    do_archived=False,
                )
            finally:
                supabase_lots.ITEMS_DIR = orig_active
                supabase_lots.ARCHIVE_ITEMS_DIR = orig_archive

        self.assertEqual(active, 1)
        self.assertEqual(archived, 0)

    def test_missing_url_raises(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_URL"):
                supabase_lots.backfill()

    def test_missing_key_raises(self):
        with patch.dict(os.environ, {"SUPABASE_URL": "https://x.sb.co"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "SUPABASE_SECRET_KEY"):
                supabase_lots.backfill()

    def test_empty_ndjson_file_skipped(self):
        session = _ok_session()
        with tempfile.TemporaryDirectory() as tmp:
            active_dir = Path(tmp) / "items"
            active_dir.mkdir()
            (active_dir / "empty.ndjson").write_text("", encoding="utf-8")

            orig_active = supabase_lots.ITEMS_DIR
            supabase_lots.ITEMS_DIR = active_dir
            try:
                active, _ = supabase_lots.backfill(
                    url="https://x.sb.co",
                    key="k",
                    session=session,
                    do_archived=False,
                )
            finally:
                supabase_lots.ITEMS_DIR = orig_active

        self.assertEqual(active, 0)
        session.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
