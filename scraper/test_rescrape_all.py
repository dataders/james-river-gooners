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
