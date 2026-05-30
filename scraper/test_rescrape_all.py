import tempfile
import unittest
from datetime import timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from rescrape_all import manifest_entry_for_file, parse_end_date


class ManifestEntryTest(unittest.TestCase):
    def test_parse_end_date_treats_cannons_times_as_eastern(self):
        parsed = parse_end_date("2026-05-27 8:28:00 PM")

        self.assertEqual(parsed.isoformat(), "2026-05-28T00:28:00+00:00")
        self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_manifest_entry_reads_parquet_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "safe-id.parquet"
            table = pa.Table.from_pylist([
                {
                    "auctionTitle": "Current Estate Auction",
                    "auctionEndDate": "2026-06-01T17:00:00+00:00",
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                    "source": "cannons",
                },
                {
                    "auctionTitle": "Current Estate Auction",
                    "auctionEndDate": "2026-06-01T17:00:00+00:00",
                    "scrapedAt": "2026-05-27T12:00:00+00:00",
                    "source": "cannons",
                },
            ])
            pq.write_table(table, path)

            entry = manifest_entry_for_file(path, archived=False)

        self.assertEqual(entry, {
            "safeId": "safe-id",
            "title": "Current Estate Auction",
            "endDate": "2026-06-01T17:00:00+00:00",
            "scrapedAt": "2026-05-27T12:00:00+00:00",
            "itemCount": 2,
            "itemsPath": "data/items/safe-id.parquet",
            "source": "cannons",
        })

    def test_manifest_entry_source_empty_for_legacy_parquet(self):
        """Old Parquet files without a source column return source='' gracefully."""
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "legacy-id.parquet"
            table = pa.Table.from_pylist([
                {
                    "auctionTitle": "Old Auction",
                    "auctionEndDate": "2025-01-01T17:00:00+00:00",
                    "scrapedAt": "2024-12-30T12:00:00+00:00",
                    # no 'source' column — simulates pre-HiBid Parquet files
                },
            ])
            pq.write_table(table, path)

            entry = manifest_entry_for_file(path, archived=False)

        self.assertEqual(entry["source"], "")

    def test_manifest_entry_includes_ndjson_path_when_sidecar_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "safe-id.parquet"
            pq.write_table(pa.Table.from_pylist([
                {"auctionTitle": "A", "auctionEndDate": "2026-06-01", "scrapedAt": "2026-05-27"},
            ]), path)
            path.with_suffix(".ndjson").write_text("{}\n")

            entry = manifest_entry_for_file(path, archived=False)

        self.assertEqual(entry["ndjsonPath"], "data/items/safe-id.ndjson")
        self.assertNotIn("embeddingsPath", entry)

    def test_manifest_entry_includes_embeddings_path_when_sidecar_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "safe-id.parquet"
            pq.write_table(pa.Table.from_pylist([
                {"auctionTitle": "A", "auctionEndDate": "2026-06-01", "scrapedAt": "2026-05-27"},
            ]), path)
            path.with_suffix(".embeddings").write_bytes(b"\x00" * 8)

            entry = manifest_entry_for_file(path, archived=False)

        self.assertEqual(entry["embeddingsPath"], "data/items/safe-id.embeddings")
        self.assertNotIn("ndjsonPath", entry)

    def test_manifest_entry_omits_sidecar_paths_when_no_sidecars(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "safe-id.parquet"
            pq.write_table(pa.Table.from_pylist([
                {"auctionTitle": "A", "auctionEndDate": "2026-06-01", "scrapedAt": "2026-05-27"},
            ]), path)

            entry = manifest_entry_for_file(path, archived=False)

        self.assertNotIn("ndjsonPath", entry)
        self.assertNotIn("embeddingsPath", entry)

    def test_archived_manifest_entry_uses_archive_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "old-id.parquet"
            table = pa.Table.from_pylist([
                {
                    "auctionTitle": "Closed Auction",
                    "auctionEndDate": "2026-03-20T17:00:00+00:00",
                    "scrapedAt": "2026-03-18T12:00:00+00:00",
                },
            ])
            pq.write_table(table, path)

            entry = manifest_entry_for_file(path, archived=True)

        self.assertEqual(entry["itemsPath"], "data/archive/items/old-id.parquet")


if __name__ == "__main__":
    unittest.main()
