import json
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

from ebay_comps import (
    append_ebay_comp_snapshots,
    build_public_exports,
    comp_rows_for_item,
    ensure_comp_tables,
    extract_ebay_item_id,
    fetch_sold_matches,
    ingest_ebay_comps,
    normalize_match_row,
    parse_sold_search_html,
    write_public_exports,
)


class EbayCompExportTest(unittest.TestCase):
    def test_ingest_ebay_comps_reads_manifest_and_writes_matches(self):
        duckdb = __import__("duckdb")
        pyarrow = __import__("pyarrow")
        parquet = __import__("pyarrow.parquet").parquet

        html = """
        <li class="s-item">
          <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
            <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
          </a>
          <span class="s-item__price">$99.00</span>
          <span class="s-item__title--tagblock"><span>Sold Mar 4, 2026</span></span>
        </li>
        """
        response = Mock(status_code=200, text=html)
        session = Mock()
        session.get.return_value = response

        with tempfile.TemporaryDirectory() as tmpdir:
            public_dir = Path(tmpdir) / "public"
            data_dir = public_dir / "data"
            items_dir = data_dir / "items"
            items_dir.mkdir(parents=True)
            parquet.write_table(
                pyarrow.Table.from_pylist([
                    {
                        "id": "item-1",
                        "lotNumber": 840,
                        "title": "Lot - 840",
                        "description": "Rosenthal crackle glaze hand-painted ceramic vase",
                        "currentBid": 37.0,
                        "totalBids": 6,
                        "endDate": "2026-05-27 8:28:00 PM",
                        "images": "[]",
                        "category": "China & Pottery",
                        "rawCategory": "China & Pottery",
                        "detailUrl": "https://example.test/item",
                        "auctionId": "auction-raw",
                        "auctionSafeId": "auction-1",
                        "auctionTitle": "Estate Auction",
                        "auctionEndDate": "2026-05-27 8:28:00 PM",
                        "scrapedAt": "2026-05-27T12:00:00+00:00",
                    }
                ]),
                items_dir / "auction-1.parquet",
            )
            (data_dir / "manifest.json").write_text(json.dumps({
                "auctions": [{
                    "safeId": "auction-1",
                    "itemsPath": "data/items/auction-1.parquet",
                }]
            }))
            db_path = str(Path(tmpdir) / "comps.duckdb")

            with patch.dict("os.environ", {"MOTHERDUCK_TOKEN": "test-token"}):
                summary = ingest_ebay_comps(
                    database=db_path,
                    data_dir=data_dir,
                    limit=1,
                    request_session=session,
                    sleep_seconds=0,
                    stale_hours=0,
                )

            con = duckdb.connect(db_path)
            try:
                rows = con.execute(
                    "select auction_safe_id, item_id, price_value, item_web_url from public_auction_comps"
                ).fetchall()
            finally:
                con.close()

        self.assertEqual(summary["items_attempted"], 1)
        self.assertEqual(summary["matches"], 1)
        self.assertEqual(rows, [("auction-1", "item-1", Decimal("99.00"), "https://www.ebay.com/itm/177917908706")])

    def test_extract_ebay_item_id_from_item_urls(self):
        self.assertEqual(
            extract_ebay_item_id("https://www.ebay.com/itm/Vintage-Rosenthal/177917908706?hash=abc"),
            "177917908706",
        )
        self.assertIsNone(extract_ebay_item_id("https://www.ebay.com/sch/i.html?_nkw=Rosenthal"))

    def test_parse_sold_search_html_keeps_real_item_links_and_prices(self):
        html = """
        <ul class="srp-results">
          <li class="s-item">
            <a class="s-item__link" href="https://www.ebay.com/itm/177917908706?itmmeta=abc">
              <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
            </a>
            <span class="s-item__price">$99.00</span>
            <span class="s-item__shipping">+$21.75 delivery</span>
            <span class="s-item__title--tagblock"><span>Sold Mar 4, 2026</span></span>
            <span class="SECONDARY_INFO">Pre-Owned</span>
            <img class="s-item__image-img" src="https://i.ebayimg.com/example.jpg" />
          </li>
          <li class="s-item">
            <a class="s-item__link" href="https://www.ebay.com/sch/i.html?_nkw=Rosenthal">
              <div class="s-item__title">Keyword search result</div>
            </a>
            <span class="s-item__price">$1.00</span>
          </li>
        </ul>
        """

        matches = parse_sold_search_html(html, source_query="specific", max_matches=5)

        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ebay_item_id"], "177917908706")
        self.assertEqual(matches[0]["item_web_url"], "https://www.ebay.com/itm/177917908706")
        self.assertEqual(matches[0]["price_value"], "99.00")
        self.assertEqual(matches[0]["shipping_label"], "+$21.75 delivery")
        self.assertEqual(matches[0]["condition"], "Pre-Owned")

    def test_fetch_sold_matches_falls_back_to_agent_browser_on_block(self):
        html = """
        <li class="s-item">
          <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
            <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
          </a>
          <span class="s-item__price">$99.00</span>
        </li>
        """
        session = Mock()
        session.get.return_value = Mock(status_code=403, text="Access Denied")
        calls = []

        def browser_runner(args, **_kwargs):
            calls.append(args)
            if args[0] == "eval":
                return html
            return ""

        result = fetch_sold_matches(
            session,
            {
                "kind": "specific",
                "query": "Rosenthal vase",
                "url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
                "warning": "",
            },
            browser_runner=browser_runner,
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matches"][0]["item_web_url"], "https://www.ebay.com/itm/177917908706")
        self.assertTrue(any(call[0] == "open" for call in calls))

    def test_comp_rows_for_item_records_no_results_without_fake_match(self):
        rows = comp_rows_for_item(
            {
                "auctionId": "auction-raw",
                "auctionSafeId": "auction-1",
                "id": "item-1",
                "lotNumber": 840,
                "title": "Lot - 840",
                "description": "Rosenthal vase",
                "currentBid": 37,
                "totalBids": 6,
                "detailUrl": "https://example.test/item",
            },
            {
                "kind": "specific",
                "query": "Rosenthal vase",
                "url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1&LH_Complete=1",
                "warning": "",
            },
            [],
            status="no_results",
            fetched_at=datetime(2026, 5, 27, 12, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "no_results")
        self.assertIsNone(rows[0]["item_web_url"])
        self.assertEqual(rows[0]["query"], "Rosenthal vase")

    def test_append_ebay_comp_snapshots_creates_public_view(self):
        duckdb = __import__("duckdb")
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "comps.duckdb")
            rows = [
                {
                    "auction_safe_id": "auction-1",
                    "item_id": "item-1",
                    "status": "ok",
                    "query": "Rosenthal vase",
                    "search_url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
                    "fetched_at": datetime(2026, 5, 27, 12, 0, tzinfo=timezone.utc),
                    "warning": None,
                    "ebay_item_id": "177917908706",
                    "title": "Vintage Rosenthal vase",
                    "price_value": "99.00",
                    "price_currency": "USD",
                    "shipping_label": "+$21.75 delivery",
                    "sold_date": None,
                    "sold_date_label": "Sold Mar 4, 2026",
                    "thumbnail_url": "https://i.ebayimg.com/example.jpg",
                    "item_web_url": "https://www.ebay.com/itm/177917908706",
                    "condition": "Pre-Owned",
                    "source_query": "specific",
                    "match_confidence": "medium",
                    "auction_id": "auction-raw",
                    "lot_number": 840,
                    "cannons_title": "Lot - 840",
                    "cannons_description": "Rosenthal vase",
                    "current_bid": "37.00",
                    "total_bids": 6,
                    "detail_url": "https://example.test/item",
                    "raw_match_json": "{}",
                }
            ]

            with patch.dict("os.environ", {"MOTHERDUCK_TOKEN": "test-token"}):
                written = append_ebay_comp_snapshots(rows, database=db_path)

            con = duckdb.connect(db_path)
            try:
                ensure_comp_tables(con)
                view_rows = con.execute(
                    "select auction_safe_id, item_id, item_web_url from public_auction_comps"
                ).fetchall()
            finally:
                con.close()

        self.assertEqual(written, 1)
        self.assertEqual(view_rows, [("auction-1", "item-1", "https://www.ebay.com/itm/177917908706")])

    def test_normalize_match_row_rejects_search_urls(self):
        row = {
            "auction_safe_id": "auction-1",
            "item_id": "item-1",
            "item_web_url": "https://www.ebay.com/sch/i.html?_nkw=Five+sterling+silver+rimmed",
            "title": "Keyword search result",
            "price_value": "55.00",
            "price_currency": "USD",
        }

        self.assertIsNone(normalize_match_row(row))

    def test_build_public_exports_groups_item_matches(self):
        rows = [
            {
                "auction_safe_id": "auction-1",
                "item_id": "item-1",
                "status": "ok",
                "query": "Rosenthal vase",
                "search_url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
                "fetched_at": datetime(2026, 5, 27, 12, 0, tzinfo=timezone.utc),
                "warning": None,
                "ebay_item_id": "177917908706",
                "title": "Vintage Rosenthal vase",
                "price_value": "99.00",
                "price_currency": "USD",
                "shipping_label": "+$21.75 delivery",
                "sold_date": "2026-03-04",
                "sold_date_label": "Sold Mar 4, 2026",
                "thumbnail_url": "https://i.ebayimg.com/example.jpg",
                "item_web_url": "https://www.ebay.com/itm/177917908706",
                "condition": "Pre-Owned",
                "source_query": "specific",
                "match_confidence": "high",
            }
        ]

        exports = build_public_exports(rows, generated_at="2026-05-27T12:00:00Z")

        self.assertEqual(list(exports), ["auction-1"])
        item = exports["auction-1"]["items"]["item-1"]
        self.assertEqual(item["status"], "ok")
        self.assertEqual(item["matches"][0]["itemWebUrl"], "https://www.ebay.com/itm/177917908706")
        self.assertEqual(item["matches"][0]["price"], {"value": "99.00", "currency": "USD"})

    def test_write_public_exports_removes_stale_files_when_rows_exist(self):
        exports = build_public_exports(
            [
                {
                    "auction_safe_id": "auction-1",
                    "item_id": "item-1",
                    "item_web_url": "https://www.ebay.com/itm/177917908706",
                    "title": "Vintage Rosenthal vase",
                    "price_value": "99.00",
                    "price_currency": "USD",
                }
            ],
            generated_at="2026-05-27T12:00:00Z",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "stale.json").write_text("{}")

            written = write_public_exports(exports, output_dir)

            self.assertEqual(written, 1)
            self.assertFalse((output_dir / "stale.json").exists())
            data = json.loads((output_dir / "auction-1.json").read_text())
            self.assertEqual(data["items"]["item-1"]["matches"][0]["price"]["value"], "99.00")


if __name__ == "__main__":
    unittest.main()
