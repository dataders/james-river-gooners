import json
import tempfile
import unittest

import ebay_comps
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from ebay_comps import (
    USER_AGENTS,
    append_ebay_comp_snapshots,
    build_ebay_sold_searches,
    build_public_exports,
    comp_rows_for_item,
    ensure_comp_tables,
    extract_ebay_item_id,
    extract_usage_headers,
    fetch_direct,
    fetch_sold_matches,
    fresh_comp_keys_from_files,
    item_exact_phrase,
    jitter_sleep,
    merge_comp_files,
    normalize_match_row,
    parse_sold_search_html,
    smoke,
    soldcomps_sold_matches,
    usage_remaining,
    utc_now_text,
)


class ExactPhraseSearchTests(unittest.TestCase):
    def test_specific_query_is_a_quoted_exact_phrase(self):
        # The motivating bug: tokenized queries matched any single word, so a
        # trumpet matched fever OR brand OR brass OR student OR trumpet.
        searches = build_ebay_sold_searches({
            "title": "Fever Brand Brass Student Trumpet",
            "description": "",
            "category": "Musical Instruments",
            "rawCategory": "Musical Instruments",
        })
        self.assertEqual(searches[0]["kind"], "specific")
        self.assertEqual(searches[0]["query"], '"Fever Brand Brass Student Trumpet"')
        # The eBay link carries the quoted phrase into _nkw.
        self.assertIn("%22Fever", searches[0]["url"])
        # Broad/category fallbacks remain, and are not quoted.
        self.assertTrue(any(
            s["kind"] == "broad" and '"' not in s["query"] for s in searches
        ))

    def test_item_exact_phrase_caps_falls_back_and_skips_single_word(self):
        self.assertEqual(
            item_exact_phrase({"title": "Vintage Omega Seamaster De Ville Automatic Wristwatch"}),
            '"Vintage Omega Seamaster De Ville Automatic"',
        )
        self.assertEqual(
            item_exact_phrase({"title": "Lot - 12", "description": "Pair of brass candlesticks"}),
            '"Pair of brass candlesticks"',
        )
        self.assertEqual(item_exact_phrase({"title": "Trumpet", "description": ""}), "")

    def test_confident_enrichment_drives_the_specific_query(self):
        # A "Lot - N" placeholder whose description is weak, but enrichment
        # identified the brand+model with high confidence: that wins the query.
        searches = build_ebay_sold_searches({
            "title": "Lot - 207",
            "description": "cordless drill, works",
            "category": "Tools",
            "rawCategory": "Tools",
            "brand": "DeWalt",
            "modelOrSku": "DCD771",
            "enrichmentConfidence": "high",
        })
        self.assertEqual(searches[0]["kind"], "specific")
        self.assertEqual(searches[0]["query"], '"DeWalt DCD771"')

    def test_low_confidence_enrichment_falls_back_to_text(self):
        # Low confidence must not steer the query — fall through to the
        # description phrase, exactly as before enrichment existed.
        searches = build_ebay_sold_searches({
            "title": "Lot - 12",
            "description": "Pair of brass candlesticks",
            "category": "Other",
            "rawCategory": "Other",
            "brand": "Maybe Acme",
            "modelOrSku": "X1",
            "enrichmentConfidence": "low",
        })
        self.assertEqual(searches[0]["query"], '"Pair of brass candlesticks"')


class Phase1QueryFilterTests(unittest.TestCase):
    """Phase 1 structured /v1/scrape filters attached to the search funnel."""

    def test_ebay_item_condition_collapses_to_api_enum(self):
        from ebay_query import ebay_item_condition

        self.assertEqual(ebay_item_condition({"condition": "new"}), "new")
        self.assertEqual(ebay_item_condition({"condition": "open box"}), "new")
        self.assertEqual(ebay_item_condition({"condition": "used"}), "used")
        self.assertEqual(ebay_item_condition({"condition": "for parts"}), "used")
        self.assertEqual(ebay_item_condition({"condition": "unknown"}), "")
        self.assertEqual(ebay_item_condition({"condition": ""}), "")
        self.assertEqual(ebay_item_condition({}), "")

    def test_ebay_category_id_maps_known_group_and_handles_unmapped(self):
        from ebay_query import ebay_category_id

        self.assertEqual(ebay_category_id({"category": "Art"}), "550")
        # Guard the YAML keys that contain "&" — these are the groups most prone
        # to a silent miss if the file ever gets HTML-escaped or mis-parsed.
        self.assertEqual(ebay_category_id({"category": "China & Glass"}), "870")
        self.assertEqual(ebay_category_id({"category": "Jewelry & Watches"}), "281")
        # Mapped to a deliberate "0" (no filter) — returned verbatim.
        self.assertEqual(ebay_category_id({"category": "Vehicles"}), "0")
        # Unmapped / absent group -> "".
        self.assertEqual(ebay_category_id({"category": "Nonexistent Group"}), "")
        self.assertEqual(ebay_category_id({}), "")

    def test_specific_tier_carries_category_and_condition_but_broad_does_not(self):
        searches = build_ebay_sold_searches({
            "title": "Fever Brand Brass Student Trumpet",
            "description": "a really nice horn here",
            "category": "Art",
            "rawCategory": "Musical Instruments",
            "condition": "used",
        })
        specific = next(s for s in searches if s["kind"] == "specific")
        broad = next(s for s in searches if s["kind"] == "broad")

        # Precise-only filters ride on `specific` alone.
        self.assertEqual(specific["category_id"], "550")
        self.assertEqual(specific["item_condition"], "used")
        self.assertNotIn("category_id", broad)
        self.assertNotIn("item_condition", broad)

    def test_safe_constraints_attach_to_every_tier(self):
        searches = build_ebay_sold_searches({
            "title": "Fever Brand Brass Student Trumpet",
            "description": "a really nice horn here for sale",
            "category": "Art",
            "rawCategory": "Musical Instruments",
        })
        self.assertTrue(len(searches) >= 2)
        for search in searches:
            self.assertEqual(search["min_price"], 5)
            self.assertEqual(search["sort_order"], "endedRecently")
            self.assertEqual(search["ebay_site"], "ebay.com")
            self.assertEqual(search["item_location"], "domestic")
            self.assertEqual(search["count"], 40)

    def test_numeric_filter_defaults_are_env_overridable(self):
        with patch.dict("os.environ", {
            "GOONERS_EBAY_COMPS_MIN_PRICE": "12",
            "GOONERS_EBAY_COMPS_COUNT": "120",
        }):
            searches = build_ebay_sold_searches({
                "title": "Vintage Omega Seamaster Automatic Wristwatch",
                "description": "",
                "category": "Jewelry & Watches",
                "rawCategory": "Jewelry & Watches",
            })
        self.assertEqual(searches[0]["min_price"], 12)
        self.assertEqual(searches[0]["count"], 120)

    def test_unmapped_category_omits_category_id_on_specific(self):
        searches = build_ebay_sold_searches({
            "title": "Distinctive Brass Telescope Antique Instrument",
            "description": "",
            "category": "Vehicles",  # mapped to "0" -> omitted
            "rawCategory": "Vehicles",
        })
        specific = next(s for s in searches if s["kind"] == "specific")
        self.assertNotIn("category_id", specific)

    def test_soldcomps_forwards_structured_filters_into_params(self):
        response = Mock(status_code=200)
        response.headers = {"X-Usage-Remaining": "100"}
        response.json.return_value = {"items": []}
        session = Mock()
        session.get.return_value = response

        soldcomps_sold_matches(
            session,
            {
                "kind": "specific",
                "query": "Rosenthal vase",
                "url": "https://example.test",
                "category_id": "870",
                "item_condition": "used",
                "min_price": 5,
                "count": 40,
                "sort_order": "endedRecently",
                "ebay_site": "ebay.com",
                "item_location": "domestic",
            },
            api_key="test-key",
        )

        params = session.get.call_args.kwargs["params"]
        self.assertEqual(params["keyword"], "Rosenthal vase")
        self.assertEqual(params["categoryId"], "870")
        self.assertEqual(params["itemCondition"], "used")
        self.assertEqual(params["minPrice"], 5)
        self.assertEqual(params["count"], 40)
        self.assertEqual(params["sortOrder"], "endedRecently")
        self.assertEqual(params["ebaySite"], "ebay.com")
        self.assertEqual(params["itemLocation"], "domestic")

    def test_soldcomps_omits_absent_filters(self):
        # A bare search (broad tier, no category/condition) sends only the keys
        # that are present — never categoryId=0 or an empty itemCondition.
        response = Mock(status_code=200)
        response.headers = {}
        response.json.return_value = {"items": []}
        session = Mock()
        session.get.return_value = response

        soldcomps_sold_matches(
            session,
            {"kind": "broad", "query": "brass vase", "url": "https://example.test"},
            api_key="test-key",
        )

        params = session.get.call_args.kwargs["params"]
        self.assertEqual(params, {"keyword": "brass vase"})


class ProviderUsageHeaderTests(unittest.TestCase):
    def test_extract_usage_headers_keeps_only_quota_headers_lowercased(self):
        usage = extract_usage_headers({
            "X-Usage-Limit": "5000",
            "X-Usage-Remaining": "1625",
            "Content-Type": "application/json",
            "X-RateLimit-Reset": "1700000000",
        })
        self.assertEqual(
            usage,
            {
                "x-usage-limit": "5000",
                "x-usage-remaining": "1625",
                "x-ratelimit-reset": "1700000000",
            },
        )

    def test_extract_usage_headers_tolerates_non_mapping(self):
        # A bare Mock (as older tests pass for response.headers) must not raise.
        self.assertEqual(extract_usage_headers(Mock()), {})

    def test_usage_remaining_parses_first_known_header(self):
        self.assertEqual(usage_remaining({"x-usage-remaining": "42"}), 42)
        self.assertEqual(usage_remaining({"x-ratelimit-remaining": "7.0"}), 7)
        self.assertIsNone(usage_remaining({"x-usage-limit": "5000"}))
        self.assertIsNone(usage_remaining({"x-usage-remaining": "n/a"}))

    def test_soldcomps_result_carries_provider_remaining(self):
        response = Mock(status_code=200)
        response.headers = {"X-Usage-Remaining": "1624", "X-Usage-Limit": "5000"}
        response.json.return_value = {"items": []}
        session = Mock()
        session.get.return_value = response

        result = soldcomps_sold_matches(
            session,
            {"kind": "broad", "query": "vase", "url": "https://example.test"},
            api_key="test-key",
        )
        self.assertEqual(result["status"], "no_results")
        self.assertEqual(result["provider_remaining"], 1624)
        self.assertEqual(result["usage"]["x-usage-limit"], "5000")


_SOLD_ITEM_HTML = """
<li class="s-item">
  <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
    <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
  </a>
  <span class="s-item__price">$99.00</span>
  <span class="s-item__title--tagblock"><span>Sold Mar 4, 2026</span></span>
</li>
"""


def _write_single_item_manifest(data_dir: Path) -> None:
    pyarrow = __import__("pyarrow")
    parquet = __import__("pyarrow.parquet").parquet
    items_dir = data_dir / "items"
    items_dir.mkdir(parents=True, exist_ok=True)
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
        "auctions": [{"safeId": "auction-1", "itemsPath": "data/items/auction-1.parquet"}]
    }))


class FetchDirectAccumulatorTest(unittest.TestCase):
    def test_accumulates_matches_into_json_without_a_warehouse(self):
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=_SOLD_ITEM_HTML)

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir) / "data"
            _write_single_item_manifest(data_dir)
            output_dir = data_dir / "ebay-comps"
            output_dir.mkdir(parents=True)
            # An existing comp from a prior run that is NOT in the manifest this
            # run; the accumulator must preserve it untouched.
            (output_dir / "auction-1.json").write_text(json.dumps({
                "schemaVersion": 2,
                "generatedAt": "2026-05-01T00:00:00Z",
                "marketplaceId": "EBAY_US",
                "source": "scraper",
                "items": {
                    "item-existing": {
                        "status": "ok",
                        "matches": [{
                            "title": "Older comp",
                            "price": {"value": "5.00", "currency": "USD"},
                            "itemWebUrl": "https://www.ebay.com/itm/111111111",
                        }],
                    }
                },
                "attempts": {"item-existing": {"fetchedAt": "2026-05-01T00:00:00Z", "status": "ok"}},
            }))

            summary = fetch_direct(
                data_dir=data_dir,
                output_dir=output_dir,
                limit=1,
                stale_hours=0,
                sleep_seconds=0,
                mirror_to_warehouse=False,
                request_session=session,
            )

            data = json.loads((output_dir / "auction-1.json").read_text())

        self.assertEqual(summary["items_attempted"], 1)
        self.assertEqual(summary["matches"], 1)
        self.assertEqual(summary["files_written"], 1)
        # Existing comp preserved, new match merged in.
        self.assertIn("item-existing", data["items"])
        self.assertEqual(data["items"]["item-1"]["matches"][0]["price"]["value"], "99.00")
        self.assertEqual(data["attempts"]["item-1"]["status"], "ok")
        self.assertEqual(data["source"], "scraper")

    def test_skips_items_that_were_fetched_recently(self):
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=_SOLD_ITEM_HTML)

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir) / "data"
            _write_single_item_manifest(data_dir)
            output_dir = data_dir / "ebay-comps"
            output_dir.mkdir(parents=True)
            (output_dir / "auction-1.json").write_text(json.dumps({
                "schemaVersion": 2,
                "items": {},
                "attempts": {"item-1": {"fetchedAt": utc_now_text(), "status": "no_results"}},
            }))

            summary = fetch_direct(
                data_dir=data_dir,
                output_dir=output_dir,
                limit=5,
                stale_hours=24,
                sleep_seconds=0,
                mirror_to_warehouse=False,
                request_session=session,
            )

        self.assertEqual(summary["items_attempted"], 0)
        session.get.assert_not_called()


class SmokeTest(unittest.TestCase):
    _EMPTY_HTML = "<html><head><title>Rosenthal | eBay</title></head><body>no results</body></html>"

    def test_returns_zero_when_a_match_is_found(self):
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=_SOLD_ITEM_HTML)
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir) / "data"
            _write_single_item_manifest(data_dir)
            code = smoke(data_dir=data_dir, limit=1, sleep_seconds=0, request_session=session)
        self.assertEqual(code, 0)

    def test_returns_one_when_no_match_is_found(self):
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=self._EMPTY_HTML)
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir) / "data"
            _write_single_item_manifest(data_dir)
            code = smoke(data_dir=data_dir, limit=1, sleep_seconds=0, request_session=session)
        self.assertEqual(code, 1)


class EbayCompExportTest(unittest.TestCase):
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
            if args[:2] == ["get", "html"] or args[0] == "eval":
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

    def test_soldcomps_response_maps_to_real_sold_matches(self):
        response = Mock(status_code=200)
        response.json.return_value = {
            "items": [
                {
                    "itemId": "177917908706",
                    "title": "Vintage Rosenthal crackle glaze vase",
                    "soldPrice": "99.00",
                    "soldCurrency": "USD",
                    "shippingPrice": "21.75",
                    "endedAt": "2026-03-04T18:42:00.000Z",
                    "url": "https://www.ebay.com/itm/177917908706",
                    "condition": "Pre-Owned",
                    "imageUrl": "https://i.ebayimg.com/example.jpg",
                },
                {
                    "itemId": "not-real",
                    "title": "Bad row",
                    "soldPrice": "1.00",
                    "url": "https://www.ebay.com/sch/i.html?_nkw=bad",
                },
            ]
        }
        session = Mock()
        session.get.return_value = response

        result = soldcomps_sold_matches(
            session,
            {
                "kind": "specific",
                "query": "Rosenthal vase",
                "url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
            },
            api_key="test-key",
            max_matches=3,
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["matches"][0]["price_value"], "99.00")
        self.assertEqual(result["matches"][0]["shipping_label"], "+$21.75 shipping")
        self.assertEqual(result["matches"][0]["sold_date"], "2026-03-04")
        self.assertEqual(result["matches"][0]["thumbnail_url"], "https://i.ebayimg.com/example.jpg")
        session.get.assert_called_once()
        self.assertEqual(session.get.call_args.kwargs["headers"]["Authorization"], "Bearer test-key")

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

    def test_merge_comp_files_drops_items_whose_latest_fetch_found_no_match(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "auction-1.json").write_text(json.dumps({
                "schemaVersion": 2,
                "items": {
                    "item-1": {"status": "ok", "matches": [{"title": "Old"}]},
                    "item-2": {"status": "ok", "matches": [{"title": "Keep me"}]},
                },
                "attempts": {},
            }))

            written = merge_comp_files(
                new_exports={},
                attempts={"auction-1": {"item-1": {"fetchedAt": "now", "status": "no_results"}}},
                output_dir=output_dir,
                generated_at="2026-05-27T12:00:00Z",
            )

            data = json.loads((output_dir / "auction-1.json").read_text())

        self.assertEqual(written, 1)
        self.assertNotIn("item-1", data["items"])  # no fresh match -> dropped
        self.assertIn("item-2", data["items"])  # untouched item preserved
        self.assertEqual(data["attempts"]["item-1"]["status"], "no_results")

    def test_fresh_comp_keys_from_files_reads_attempts_and_items(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "auction-1.json").write_text(json.dumps({
                "items": {"item-old": {"fetchedAt": "2020-01-01T00:00:00Z"}},
                "attempts": {
                    "item-fresh": {"fetchedAt": utc_now_text(), "status": "no_results"},
                    "item-stale": {"fetchedAt": "2020-01-01T00:00:00Z", "status": "ok"},
                },
            }))

            fresh = fresh_comp_keys_from_files(output_dir, stale_hours=24)

        self.assertIn("auction-1:item-fresh", fresh)
        self.assertNotIn("auction-1:item-stale", fresh)
        self.assertNotIn("auction-1:item-old", fresh)


_SEARCH = {
    "kind": "specific",
    "query": "Rosenthal vase",
    "url": "https://www.ebay.com/sch/i.html?_nkw=Rosenthal+vase&LH_Sold=1",
    "warning": "",
}
_ITEM_HTML = """
<li class="s-item">
  <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
    <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
  </a>
  <span class="s-item__price">$99.00</span>
</li>
"""


class JitterSleepTest(unittest.TestCase):
    def test_calls_sleep_with_half_to_two_and_half_x_range(self):
        recorded = []
        jitter_sleep(2.0, _rand=lambda lo, hi: recorded.append((lo, hi)) or lo)
        self.assertEqual(len(recorded), 1)
        lo, hi = recorded[0]
        self.assertAlmostEqual(lo, 1.0)
        self.assertAlmostEqual(hi, 5.0)

    def test_skips_sleep_when_base_is_zero(self):
        calls = []
        jitter_sleep(0, _rand=lambda lo, hi: calls.append((lo, hi)) or 0)
        self.assertEqual(calls, [])

    def test_skips_sleep_when_base_is_negative(self):
        calls = []
        jitter_sleep(-1.0, _rand=lambda lo, hi: calls.append((lo, hi)) or 0)
        self.assertEqual(calls, [])


class FetchSoldMatchesAntiBlockingTest(unittest.TestCase):
    def test_uses_random_user_agent_from_pool(self):
        session = Mock()
        captured = []

        def capture(*args, **kwargs):
            captured.append(kwargs.get("headers", {}).get("User-Agent", ""))
            return Mock(status_code=200, text=_ITEM_HTML)

        session.get.side_effect = capture

        fetch_sold_matches(session, _SEARCH, _choice=lambda lst: lst[2])
        self.assertEqual(captured[0], USER_AGENTS[2])

    def test_env_override_takes_precedence_over_pool(self):
        session = Mock()
        captured = []

        def capture(*args, **kwargs):
            captured.append(kwargs.get("headers", {}).get("User-Agent", ""))
            return Mock(status_code=200, text=_ITEM_HTML)

        session.get.side_effect = capture

        with patch.dict("os.environ", {"GOONERS_EBAY_USER_AGENT": "CustomBot/1.0"}):
            fetch_sold_matches(session, _SEARCH, _choice=lambda lst: lst[0])

        self.assertEqual(captured[0], "CustomBot/1.0")

    def test_retries_once_on_429_and_succeeds(self):
        session = Mock()
        session.get.side_effect = [
            Mock(status_code=429, text="Too Many Requests"),
            Mock(status_code=200, text=_ITEM_HTML),
        ]

        result = fetch_sold_matches(session, _SEARCH, _rand=lambda lo, hi: 0)

        self.assertEqual(session.get.call_count, 2)
        self.assertNotEqual(result["status"], "blocked")

    def test_marks_blocked_when_both_429_attempts_fail(self):
        session = Mock()
        session.get.return_value = Mock(status_code=429, text="Too Many Requests")

        with patch.dict("os.environ", {"GOONERS_EBAY_BROWSER_FALLBACK": "0"}):
            result = fetch_sold_matches(session, _SEARCH, _rand=lambda lo, hi: 0)

        self.assertEqual(result["status"], "blocked")
        self.assertEqual(session.get.call_count, 2)

    def test_does_not_retry_on_403(self):
        session = Mock()
        session.get.return_value = Mock(status_code=403, text="Access Denied")

        with patch.dict("os.environ", {"GOONERS_EBAY_BROWSER_FALLBACK": "0"}):
            result = fetch_sold_matches(session, _SEARCH, _rand=lambda lo, hi: 0)

        self.assertEqual(session.get.call_count, 1)
        self.assertEqual(result["status"], "blocked")


class StaleDiretKeysTest(unittest.TestCase):
    def test_returns_fresh_keys_from_existing_json(self):
        fresh_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = {
            "items": {
                "item-1": {"fetchedAt": fresh_ts, "matches": []},
                "item-2": {"fetchedAt": fresh_ts, "matches": []},
            }
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "auction-1.json").write_text(json.dumps(payload))
            keys = fresh_comp_keys_from_files(output_dir, stale_hours=168)

        self.assertIn("auction-1:item-1", keys)
        self.assertIn("auction-1:item-2", keys)

    def test_excludes_stale_entries(self):
        old_ts = "2000-01-01T00:00:00Z"
        payload = {"items": {"item-1": {"fetchedAt": old_ts, "matches": []}}}
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "auction-1.json").write_text(json.dumps(payload))
            keys = fresh_comp_keys_from_files(output_dir, stale_hours=168)

        self.assertNotIn("auction-1:item-1", keys)

    def test_returns_empty_when_stale_hours_is_zero(self):
        fresh_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        payload = {"items": {"item-1": {"fetchedAt": fresh_ts}}}
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir)
            (output_dir / "auction-1.json").write_text(json.dumps(payload))
            keys = fresh_comp_keys_from_files(output_dir, stale_hours=0)

        self.assertEqual(keys, set())


class FetchDirectTest(unittest.TestCase):
    def _make_data_dir(self, tmpdir: str) -> Path:
        pyarrow = __import__("pyarrow")
        parquet = __import__("pyarrow.parquet").parquet

        data_dir = Path(tmpdir) / "public" / "data"
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
            "auctions": [{"safeId": "auction-1", "itemsPath": "data/items/auction-1.parquet"}]
        }))
        return data_dir

    def test_writes_json_files_directly_without_motherduck(self):
        html = """
        <li class="s-item">
          <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
            <div class="s-item__title">Vintage Rosenthal crackle glaze vase</div>
          </a>
          <span class="s-item__price">$99.00</span>
        </li>
        """
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=html)

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = self._make_data_dir(tmpdir)
            output_dir = Path(tmpdir) / "ebay-comps"

            summary = fetch_direct(
                data_dir=data_dir,
                output_dir=output_dir,
                limit=10,
                request_session=session,
                sleep_seconds=0,
                stale_hours=0,
            )

            self.assertEqual(summary["items_attempted"], 1)
            self.assertEqual(summary["matches"], 1)
            self.assertFalse(summary["blocked"])

            output_file = output_dir / "auction-1.json"
            self.assertTrue(output_file.exists())
            data = json.loads(output_file.read_text())
            self.assertIn("item-1", data["items"])
            match = data["items"]["item-1"]["matches"][0]
            self.assertEqual(match["itemWebUrl"], "https://www.ebay.com/itm/177917908706")
            self.assertEqual(match["price"]["value"], "99.00")

    def test_skips_fresh_items_based_on_existing_json(self):
        fresh_ts = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        session = Mock()
        session.get.return_value = Mock(status_code=200, text="")

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = self._make_data_dir(tmpdir)
            output_dir = Path(tmpdir) / "ebay-comps"
            output_dir.mkdir()
            (output_dir / "auction-1.json").write_text(json.dumps({
                "items": {"item-1": {"fetchedAt": fresh_ts, "matches": []}}
            }))

            summary = fetch_direct(
                data_dir=data_dir,
                output_dir=output_dir,
                limit=10,
                request_session=session,
                sleep_seconds=0,
                stale_hours=168,
            )

        self.assertEqual(summary["items_attempted"], 0)
        session.get.assert_not_called()

    def test_dry_run_does_not_write_files(self):
        html = """
        <li class="s-item">
          <a class="s-item__link" href="https://www.ebay.com/itm/177917908706">
            <div class="s-item__title">Vintage Rosenthal vase</div>
          </a>
          <span class="s-item__price">$99.00</span>
        </li>
        """
        session = Mock()
        session.get.return_value = Mock(status_code=200, text=html)

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = self._make_data_dir(tmpdir)
            output_dir = Path(tmpdir) / "ebay-comps"

            fetch_direct(
                data_dir=data_dir,
                output_dir=output_dir,
                limit=10,
                request_session=session,
                sleep_seconds=0,
                stale_hours=0,
                dry_run=True,
            )

        self.assertFalse(output_dir.exists())

    def test_stops_on_block_and_reports_it(self):
        session = Mock()
        session.get.return_value = Mock(status_code=403, text="Access Denied")

        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = self._make_data_dir(tmpdir)
            output_dir = Path(tmpdir) / "ebay-comps"

            with patch.dict("os.environ", {"GOONERS_EBAY_BROWSER_FALLBACK": "0"}):
                summary = fetch_direct(
                    data_dir=data_dir,
                    output_dir=output_dir,
                    limit=10,
                    request_session=session,
                    sleep_seconds=0,
                    stale_hours=0,
                )

        self.assertTrue(summary["blocked"])


class BackfillBudgetTest(unittest.TestCase):
    """Shared request budget, daily pacing, skip-attempted, end-date priority."""

    @staticmethod
    def _item(item_id, title="Vintage Fenton Glass Vase", safe_id="A",
              end="2026-05-31 6:19:00 PM"):
        return {
            "auctionSafeId": safe_id,
            "id": str(item_id),
            "title": f"{title} {item_id}",
            "auctionEndDate": end,
        }

    def test_max_queries_caps_requests(self):
        items = [self._item(i) for i in range(10)]
        calls = {"n": 0}

        def fake(session, search, max_matches=3):
            calls["n"] += 1
            return {"status": "no_results", "matches": [], "warning": None}

        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.load_manifest_items", return_value=items), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake):
            summary = ebay_comps.fetch_direct(
                output_dir=Path(tmp), limit=100, queries_per_item=2, max_queries=5,
                monthly_budget=0, stale_hours=0, sleep_seconds=0,
                mirror_to_warehouse=False,
            )
        # 10 items x 2 queries would be 20 requests; the cap holds it to 5.
        self.assertEqual(calls["n"], 5)
        self.assertEqual(summary["queries_attempted"], 5)

    def test_monthly_budget_derived_from_read_model(self):
        items = [self._item(i) for i in range(10)]

        def fake(session, search, max_matches=3):
            return {"status": "no_results", "matches": [], "warning": None}

        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.load_manifest_items", return_value=items), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake):
            out = Path(tmp)
            today = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            # Per-auction file: attempts keyed by item id, "queries" = requests spent.
            ebay_comps.write_comp_file(out / "PRE.json", {
                "schemaVersion": 2, "items": {},
                "attempts": {"x": {"fetchedAt": today, "status": "no_results",
                                   "queries": 1998}}})
            summary = ebay_comps.fetch_direct(
                output_dir=out, limit=100, queries_per_item=2, monthly_budget=2000,
                daily_pacing=False, stale_hours=0, sleep_seconds=0,
                mirror_to_warehouse=False,
            )
        self.assertEqual(summary["queries_attempted"], 2)  # only 2 of 2000 left

    def test_daily_pacing_spreads_budget_across_month(self):
        with tempfile.TemporaryDirectory() as tmp:
            # May has 31 days; from the 30th, 2 days remain -> ceil(2000/2) = 1000.
            now = datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc)
            cap_active, limit = ebay_comps.resolve_query_budget(
                ebay_comps.FileCompLedger(Path(tmp)),
                monthly_budget=2000, max_queries=0, daily_pacing=True, now=now)
        self.assertTrue(cap_active)
        self.assertEqual(limit, 1000)

    def test_provider_meter_unblocks_when_coarse_count_exhausted(self):
        # Issue #299: the coarse attempt count says the monthly cap is spent, but
        # the provider's own meter still has quota — the run must not be blocked.
        ledger = Mock()
        ledger.provider_remaining.return_value = 1620
        ledger.provider_used_today.return_value = 0
        ledger.requests_used_in_month.return_value = 5000  # coarse: "exhausted"
        cap_active, limit = ebay_comps.resolve_query_budget(
            ledger, monthly_budget=5000, max_queries=0, daily_pacing=False)
        self.assertTrue(cap_active)
        self.assertEqual(limit, 1620)  # gated on the provider meter
        ledger.requests_used_in_month.assert_not_called()  # coarse count ignored

    def test_monthly_budget_caps_provider_remaining(self):
        # --monthly-budget stays a secondary coarse cap below the provider meter.
        ledger = Mock()
        ledger.provider_remaining.return_value = 4000
        ledger.provider_used_today.return_value = 0
        _, limit = ebay_comps.resolve_query_budget(
            ledger, monthly_budget=2000, max_queries=0, daily_pacing=False)
        self.assertEqual(limit, 2000)

    def test_provider_min_remaining_floor_subtracted(self):
        ledger = Mock()
        ledger.provider_remaining.return_value = 100
        ledger.provider_used_today.return_value = 0
        _, limit = ebay_comps.resolve_query_budget(
            ledger, monthly_budget=5000, max_queries=0, daily_pacing=False,
            provider_min_remaining=20)
        self.assertEqual(limit, 80)

    def test_daily_pacing_uses_provider_used_today_not_coarse(self):
        # June 14 → 17 days left; ceil(1700/17)=100/day; 50 already spent today.
        ledger = Mock()
        ledger.provider_remaining.return_value = 1700
        ledger.provider_used_today.return_value = 50
        ledger.requests_used_today.return_value = 9999  # coarse overcount ignored
        now = datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc)
        _, limit = ebay_comps.resolve_query_budget(
            ledger, monthly_budget=5000, max_queries=0, daily_pacing=True, now=now)
        self.assertEqual(limit, 50)
        ledger.requests_used_today.assert_not_called()

    def test_budget_falls_back_to_coarse_count_without_provider_reading(self):
        ledger = Mock()
        ledger.provider_remaining.return_value = None  # no header cached yet
        ledger.requests_used_in_month.return_value = 4990
        _, limit = ebay_comps.resolve_query_budget(
            ledger, monthly_budget=5000, max_queries=0, daily_pacing=False)
        self.assertEqual(limit, 10)

    def test_skip_attempted_overrides_staleness(self):
        from datetime import timedelta

        called = {"n": 0}

        def fake(session, search, max_matches=3):
            called["n"] += 1
            return {"status": "ok", "matches": [{"ebayItemId": "9"}], "warning": None}

        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.load_manifest_items", return_value=[self._item(0)]), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake):
            out = Path(tmp)
            old = (datetime.now(timezone.utc) - timedelta(days=90)).isoformat().replace(
                "+00:00", "Z")
            ebay_comps.write_comp_file(out / "A.json", {
                "schemaVersion": 2, "items": {},
                "attempts": {"0": {"fetchedAt": old, "status": "no_results",
                                   "queries": 2}}})
            summary = ebay_comps.fetch_direct(
                output_dir=out, limit=10, queries_per_item=2, monthly_budget=0,
                stale_hours=168, skip_attempted=True, sleep_seconds=0,
                mirror_to_warehouse=False,
            )
        self.assertEqual(called["n"], 0)  # stale, but already attempted -> skipped
        self.assertEqual(summary["items_attempted"], 0)

    def test_provider_remaining_floor_stops_the_run(self):
        # The provider reports remaining quota on each response; once it hits the
        # floor the run stops, regardless of the ledger-based monthly budget.
        items = [self._item(i) for i in range(10)]
        calls = {"n": 0}

        def fake(session, search, max_matches=3):
            calls["n"] += 1
            # Provider says one request left, then zero on the next call.
            remaining = max(0, 2 - calls["n"])
            return {
                "status": "no_results",
                "matches": [],
                "warning": None,
                "provider_remaining": remaining,
            }

        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.load_manifest_items", return_value=items), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake):
            summary = ebay_comps.fetch_direct(
                output_dir=Path(tmp), limit=100, queries_per_item=1,
                monthly_budget=0, stale_hours=0, sleep_seconds=0,
                mirror_to_warehouse=False, provider_min_remaining=0,
            )
        # Second call returns remaining=0 → stop. No third request is made.
        self.assertEqual(calls["n"], 2)
        self.assertTrue(summary["provider_exhausted"])
        self.assertEqual(summary["provider_remaining"], 0)

    def test_prioritizes_soonest_ending_auction(self):
        later = self._item("l", title="Distinctive Walnut Dresser Antique",
                           safe_id="LATE", end="2026-06-30 6:00:00 PM")
        sooner = self._item("s", title="Distinctive Brass Telescope Antique",
                            safe_id="SOON", end="2026-06-01 6:00:00 PM")
        seen = []

        def fake(session, search, max_matches=3):
            seen.append(search.get("query", ""))
            return {"status": "ok", "matches": [{"ebayItemId": "1"}], "warning": None}

        # Reverse-priority input order proves sorting (not input order) drives it.
        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.load_manifest_items", return_value=[later, sooner]), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake):
            ebay_comps.fetch_direct(
                output_dir=Path(tmp), limit=1, queries_per_item=1, monthly_budget=0,
                stale_hours=0, sleep_seconds=0, mirror_to_warehouse=False,
            )
        self.assertTrue(any("telescope" in q.lower() for q in seen))
        self.assertFalse(any("dresser" in q.lower() for q in seen))

    def test_auction_end_sort_key_orders_and_handles_missing(self):
        soon = ebay_comps.auction_end_sort_key({"auctionEndDate": "2026-05-31 6:19:00 PM"})
        late = ebay_comps.auction_end_sort_key({"auctionEndDate": "2026-06-04 6:09:00 PM"})
        missing = ebay_comps.auction_end_sort_key({"auctionEndDate": ""})
        self.assertLess(soon, late)
        self.assertLess(late, missing)


class FetchDirectSupabaseModeTest(unittest.TestCase):
    """With Supabase as the backend, the run reads/writes the table, not JSON."""

    @staticmethod
    def _item(item_id=0):
        return {
            "auctionSafeId": "A",
            "id": str(item_id),
            "title": "Distinctive Brass Telescope Antique",
            "auctionEndDate": "2026-06-30 6:00:00 PM",
        }

    def test_supabase_mode_writes_no_json_and_mirrors_rows(self):
        fake_ledger = Mock()
        fake_ledger.fresh_keys.return_value = set()
        fake_ledger.requests_used_in_month.return_value = 0
        fake_ledger.requests_used_today.return_value = 0

        def fake(session, search, max_matches=3):
            return {
                "status": "ok",
                "matches": [{
                    "ebay_item_id": "9",
                    "item_web_url": "https://www.ebay.com/itm/9",
                    "price_value": "10",
                }],
                "warning": None,
            }

        with tempfile.TemporaryDirectory() as tmp, \
                patch("ebay_comps.supabase_comp_backend_active", return_value=True), \
                patch("supabase_comps.SupabaseCompLedger", return_value=fake_ledger), \
                patch("ebay_comps.load_manifest_items", return_value=[self._item()]), \
                patch("ebay_comps.fetch_sold_matches", side_effect=fake), \
                patch("ebay_comps.mirror_rows_to_warehouse") as mirror:
            out = Path(tmp)
            summary = ebay_comps.fetch_direct(
                output_dir=out, limit=10, queries_per_item=1, monthly_budget=0,
                stale_hours=0, sleep_seconds=0, mirror_to_warehouse=True,
            )

        self.assertEqual(summary["files_written"], 0)
        self.assertEqual(list(out.glob("*.json")), [])  # no JSON read model written
        fake_ledger.fresh_keys.assert_called_once()  # freshness came from the ledger
        mirror.assert_called_once()
        mirrored_rows = mirror.call_args[0][0]
        self.assertTrue(any(r.get("item_web_url") for r in mirrored_rows))

    def test_no_mirror_forces_file_backend_even_if_supabase_configured(self):
        # --no-mirror (mirror_to_warehouse=False) must never touch Supabase.
        with patch("ebay_comps.supabase_comp_backend_active") as active, \
                patch("ebay_comps.load_manifest_items", return_value=[self._item()]), \
                patch("ebay_comps.fetch_sold_matches",
                      return_value={"status": "no_results", "matches": [], "warning": None}), \
                tempfile.TemporaryDirectory() as tmp:
            ebay_comps.fetch_direct(
                output_dir=Path(tmp), limit=1, queries_per_item=1, monthly_budget=0,
                stale_hours=0, sleep_seconds=0, mirror_to_warehouse=False,
            )
        active.assert_not_called()  # short-circuited before the backend check


if __name__ == "__main__":
    unittest.main()
