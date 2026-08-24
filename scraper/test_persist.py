import json
import sys
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import persist
from persist import WriteContext, write_read_model


def _ctx(tmp: Path, **over) -> WriteContext:
    ctx = WriteContext(
        safe_id="src_42",
        auction_id="42",
        auction_title="Test Auction",
        auction_end_date="2026-06-01T23:00:00+00:00",
        source="testsrc",
        source_url="https://example.com/auctions/42",
        scraped_at="2026-05-30T12:00:00+00:00",
        session=mock.Mock(),
        snapshot_to_motherduck=False,
        auction_city="Richmond",
        auction_state="VA",
    )
    return replace(ctx, **over) if over else ctx


def _item(**over) -> dict:
    item = {
        "id": "src_1",
        "lotNumber": 1,
        "title": "Thing",
        "description": "A thing",
        "currentBid": 10.0,
        "totalBids": 2,
        "endDate": "2026-06-01T23:00:00+00:00",
        "images": ["https://img/a.jpg", "https://img/b.jpg"],
        "category": "Misc",
        "rawCategory": "Misc",
        "detailUrl": "https://example.com/lot/1",
    }
    item.update(over)
    return item


class WriteReadModelTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        tmp = Path(self._tmp.name)
        # Redirect the module-level dirs at writes go to a scratch dir.
        self._items_dir = tmp / "items"
        self.items_patch = mock.patch.object(persist, "ITEMS_DIR", self._items_dir)
        self.items_patch.start()

        # Stub every external side effect so the test stays hermetic. enrich_items
        # returns False (no enrichment ran) so the summary branch is skipped.
        self.enrich = mock.patch("enrich.enrich_items", return_value=False).start()
        mock.patch("enrich.load_prior_enrichment", return_value={}).start()
        self.export_enrich = mock.patch(
            "supabase_enrichment.maybe_export_enrichment"
        ).start()
        # embed_nomic imports numpy/torch at module load; stub the whole module
        # so the test is hermetic on a runner without the embedding deps.
        self.embed = mock.Mock()
        fake_embed = mock.Mock()
        fake_embed.maybe_generate_and_upsert = self.embed
        mock.patch.dict(sys.modules, {"embed_nomic": fake_embed}).start()

        # Stub the geocoder so the test doesn't depend on geocode_cache.yml; the
        # gate's own behaviour is covered by test_geocode.
        self.geocode = mock.patch(
            "geocode.resolve", return_value=(37.5407, -77.436)
        ).start()

    def tearDown(self):
        mock.patch.stopall()
        self._tmp.cleanup()

    def test_stamps_metadata_and_writes_ndjson_and_parquet(self):
        items = [_item()]
        ctx = _ctx(Path(self._tmp.name))
        result = write_read_model(items, ctx)

        self.assertEqual(result, {"changed": True, "count": 1})

        # NDJSON sidecar: images stay a real array, metadata stamped.
        ndjson = self._items_dir / "src_42.ndjson"
        rows = [
            json.loads(line) for line in ndjson.read_text().splitlines() if line.strip()
        ]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["auctionId"], "42")
        self.assertEqual(row["auctionSafeId"], "src_42")
        self.assertEqual(row["auctionTitle"], "Test Auction")
        self.assertEqual(row["auctionEndDate"], "2026-06-01T23:00:00+00:00")
        self.assertEqual(row["scrapedAt"], "2026-05-30T12:00:00+00:00")
        self.assertEqual(row["source"], "testsrc")
        self.assertEqual(row["images"], ["https://img/a.jpg", "https://img/b.jpg"])
        # Auction location stamped for the distance filter (geocode stubbed).
        self.assertEqual(row["auctionCity"], "Richmond")
        self.assertEqual(row["auctionState"], "VA")
        self.assertEqual(row["auctionLatitude"], 37.5407)
        self.assertEqual(row["auctionLongitude"], -77.436)
        self.geocode.assert_called_once_with("Richmond", "VA")

        # Parquet stringifies images in place.
        self.assertEqual((self._items_dir / "src_42.parquet").exists(), True)
        self.assertEqual(
            items[0]["images"], json.dumps(["https://img/a.jpg", "https://img/b.jpg"])
        )

    def test_upserts_parent_lots_before_exporting_enrichment(self):
        calls = []
        self.export_enrich.side_effect = lambda *args, **kwargs: calls.append("enrich")
        with mock.patch.object(
            persist,
            "_upsert_supabase_lots",
            side_effect=lambda *args, **kwargs: calls.append("lots"),
        ):
            write_read_model([_item()], _ctx(Path(self._tmp.name)))

        self.assertEqual(calls, ["lots", "enrich"])

    def test_embeddings_invoked_for_every_source(self):
        """The whole point of the shared tail: HiBid/Rasmus no longer skip embeddings."""
        items = [_item()]
        session = mock.Mock()
        ctx = _ctx(Path(self._tmp.name), session=session)
        with mock.patch.dict("os.environ", {"GOONERS_NOMIC_EMBEDDINGS": "1"}):
            write_read_model(items, ctx)
        self.embed.assert_called_once_with(items, "src_42", session)

    def test_embeddings_skipped_without_optin(self):
        """With embeddings off, the tail must not reach embed_nomic at all (so a
        scrape doesn't need numpy/the ML stack just to write the read model)."""
        items = [_item()]
        with mock.patch.dict("os.environ", {"GOONERS_NOMIC_EMBEDDINGS": "0"}):
            write_read_model(items, _ctx(Path(self._tmp.name)))
        self.embed.assert_not_called()

    def test_fill_blank_end_dates_only_when_requested(self):
        # Without the flag, a blank per-lot endDate is left blank.
        items = [_item(endDate="")]
        write_read_model(items, _ctx(Path(self._tmp.name), fill_blank_end_dates=False))
        self.assertEqual(items[0]["endDate"], "")

        # With the flag (Cannon's closed lots), it inherits the auction end date.
        items2 = [_item(endDate="")]
        write_read_model(items2, _ctx(Path(self._tmp.name), fill_blank_end_dates=True))
        self.assertEqual(items2[0]["endDate"], "2026-06-01T23:00:00+00:00")

    def test_enrichment_export_runs(self):
        items = [_item()]
        write_read_model(items, _ctx(Path(self._tmp.name)))
        self.enrich.assert_called_once()
        self.export_enrich.assert_called_once_with(items)


if __name__ == "__main__":
    unittest.main()
