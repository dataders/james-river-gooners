import unittest
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


if __name__ == "__main__":
    unittest.main()
