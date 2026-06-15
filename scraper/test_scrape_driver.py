"""Tests for the generic per-source scrape driver in rescrape_all."""

import sys
import unittest
from unittest import mock

import rescrape_all
from rescrape_all import (
    HIBID,
    MAXANET,
    RASMUS,
    _hibid_job,
    _maxanet_job,
    _rasmus_job,
    _scrape_source,
)


class JobBuilderTest(unittest.TestCase):
    def test_maxanet_job(self):
        job = _maxanet_job("https://bid.cannonsauctions.com/x?AuctionId=abc")
        self.assertEqual(
            job.cmd,
            [
                sys.executable,
                "scrape.py",
                "https://bid.cannonsauctions.com/x?AuctionId=abc",
            ],
        )
        self.assertEqual(job.fail_id, "https://bid.cannonsauctions.com/x?AuctionId=abc")

    def test_hibid_job_passes_source_and_company(self):
        job = _hibid_job(
            {
                "catalog_url": "https://hibid.com/catalog/123/",
                "source_slug": "acme",
                "company_name": "Acme Auctions",
            }
        )
        self.assertEqual(job.cmd[1], "scrape_hibid.py")
        self.assertIn("--source", job.cmd)
        self.assertIn("acme", job.cmd)
        self.assertIn("Acme Auctions", job.cmd)
        self.assertEqual(job.fail_id, "https://hibid.com/catalog/123/")

    def test_rasmus_job_passes_title(self):
        job = _rasmus_job(
            {
                "aid": "aid42",
                "source_slug": "rasmus",
                "company_name": "Rasmus",
                "title": "Richmond Estate Sale",
            }
        )
        self.assertEqual(job.cmd[1], "scrape_rasmus.py")
        self.assertIn("--title", job.cmd)
        self.assertIn("Richmond Estate Sale", job.cmd)
        self.assertEqual(job.fail_id, "aid42")


class ScrapeSourceTest(unittest.TestCase):
    def test_collects_failures_by_fail_id(self):
        # First spec succeeds (rc 0), second fails (rc 1).
        with mock.patch.object(rescrape_all, "_run_with_retry", side_effect=[0, 1]):
            failures = _scrape_source(
                HIBID,
                [
                    {
                        "catalog_url": "https://hibid.com/catalog/1/",
                        "source_slug": "s",
                        "company_name": "C",
                    },
                    {
                        "catalog_url": "https://hibid.com/catalog/2/",
                        "source_slug": "s",
                        "company_name": "C",
                    },
                ],
                total=2,
                start_i=1,
            )
        self.assertEqual(failures, ["https://hibid.com/catalog/2/"])

    def test_runs_each_spec_once_with_built_command(self):
        calls = []
        with mock.patch.object(
            rescrape_all,
            "_run_with_retry",
            side_effect=lambda cmd, cwd, label: calls.append(cmd) or 0,
        ):
            _scrape_source(MAXANET, ["urlA", "urlB"], total=2, start_i=1)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], [sys.executable, "scrape.py", "urlA"])

    def test_runner_names(self):
        self.assertEqual(
            (MAXANET.name, HIBID.name, RASMUS.name), ("Maxanet", "HiBid", "Rasmus")
        )


if __name__ == "__main__":
    unittest.main()
