import tempfile
import unittest
from pathlib import Path
from unittest import mock

import backfill_closed


class BackfillSkipAndLimitTest(unittest.TestCase):
    def _url(self, auction_id: str) -> str:
        return (
            "https://bid.cannonsauctions.com/Public/Auction/AuctionItems"
            f"?AuctionId={auction_id}&Title=t"
        )

    def test_skips_existing_and_respects_limit(self):
        # Three candidates; the first is already in the read model and should be
        # skipped, so the limit of 2 lands on the next two fresh auctions.
        urls = [self._url("aaa"), self._url("bbb"), self._url("ccc")]
        scraped = []

        with mock.patch.object(
            backfill_closed, "discover_past_auction_urls", return_value=urls
        ), mock.patch.object(
            backfill_closed, "existing_safe_ids", return_value={"aaa"}
        ), mock.patch.object(
            backfill_closed, "scrape_auction", side_effect=lambda u: scraped.append(u)
        ), mock.patch.object(
            backfill_closed, "finalize_closed_file"
        ), mock.patch.object(
            backfill_closed, "archive_file"
        ) as archive, mock.patch.object(
            backfill_closed.Path, "exists", return_value=True
        ), mock.patch.object(
            backfill_closed, "update_manifests"
        ) as update:
            failures = backfill_closed.backfill(limit=2)

        self.assertEqual(failures, 0)
        self.assertEqual(scraped, [self._url("bbb"), self._url("ccc")])
        self.assertEqual(archive.call_count, 2)
        update.assert_called_once()

    def test_counts_scrape_failures_without_aborting(self):
        urls = [self._url("bbb"), self._url("ccc")]

        def flaky(url):
            if "bbb" in url:
                raise RuntimeError("boom")

        with mock.patch.object(
            backfill_closed, "discover_past_auction_urls", return_value=urls
        ), mock.patch.object(
            backfill_closed, "existing_safe_ids", return_value=set()
        ), mock.patch.object(
            backfill_closed, "scrape_auction", side_effect=flaky
        ), mock.patch.object(
            backfill_closed, "finalize_closed_file"
        ), mock.patch.object(
            backfill_closed, "archive_file"
        ), mock.patch.object(
            backfill_closed.Path, "exists", return_value=True
        ), mock.patch.object(
            backfill_closed, "update_manifests"
        ):
            failures = backfill_closed.backfill(limit=2)

        # One auction raised; the other still processed. update_manifests runs
        # regardless so the archive manifest reflects whatever landed.
        self.assertEqual(failures, 1)


class HibidJobsConfigTest(unittest.TestCase):
    def test_reads_closed_catalog_ids_from_sources(self):
        yml = (
            "companies:\n"
            "  - id: 1\n"
            "    slug: acme\n"
            "    name: Acme\n"
            "    closed_catalog_ids: [111, 222]\n"
            "  - id: 2\n"
            "    slug: other\n"
            "    name: Other\n"  # no closed_catalog_ids -> contributes nothing
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hibid.yml"
            path.write_text(yml)
            jobs = backfill_closed._hibid_jobs(sources_file=path)

        self.assertEqual([safe_id for safe_id, _, _ in jobs], ["hibid_111", "hibid_222"])

    def test_no_closed_ids_yields_no_jobs(self):
        yml = "companies:\n  - id: 1\n    slug: acme\n    name: Acme\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hibid.yml"
            path.write_text(yml)
            self.assertEqual(backfill_closed._hibid_jobs(sources_file=path), [])


if __name__ == "__main__":
    unittest.main()
