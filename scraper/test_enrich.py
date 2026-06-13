import json
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import enrich
from enrich import (
    _RateLimiter,
    build_content,
    enrich_items,
    enrich_items_batch,
    enrichment_fingerprint,
    is_enrichment_enabled,
    item_images,
    item_prompt_text,
    load_prior_enrichment,
    parse_enrichment,
)


class _FakeBlock:
    def __init__(self, text):
        self.type = "text"
        self.text = text


class _FakeMessages:
    """Returns a canned structured-output JSON per item, keyed by the lot id in
    the request text, so a multi-item run can assert per-item results."""

    def __init__(self, by_keyword):
        self.by_keyword = by_keyword
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        text = ""
        for block in kwargs["messages"][0]["content"]:
            if block.get("type") == "text":
                text = block["text"]
        for keyword, payload in self.by_keyword.items():
            if keyword in text:
                if isinstance(payload, Exception):
                    raise payload
                return mock.Mock(content=[_FakeBlock(json.dumps(payload))])
        return mock.Mock(content=[_FakeBlock(json.dumps({}))])


class _FakeClient:
    def __init__(self, by_keyword):
        self.messages = _FakeMessages(by_keyword)


def _prompt_text(params):
    for block in params["messages"][0]["content"]:
        if block.get("type") == "text":
            return block["text"]
    return ""


class _FakeBatchOutcome:
    def __init__(self, type_, message=None):
        self.type = type_
        self.message = message


class _FakeBatchResult:
    def __init__(self, custom_id, outcome):
        self.custom_id = custom_id
        self.result = outcome


class _FakeBatches:
    """Mimics client.messages.batches: create() captures the requests, retrieve()
    reports ended immediately, results() returns a per-request outcome keyed by
    the lot text (Exception payload → an `errored` outcome, not a raise)."""

    def __init__(self, by_keyword):
        self.by_keyword = by_keyword
        self.created = 0
        self._requests = []

    def create(self, requests):
        self.created += 1
        self._requests = requests
        return mock.Mock(id="batch_test", processing_status="in_progress")

    def retrieve(self, batch_id):
        return mock.Mock(
            processing_status="ended",
            request_counts=mock.Mock(processing=0, succeeded=len(self._requests), errored=0),
        )

    def results(self, batch_id):
        for req in self._requests:
            text = _prompt_text(req["params"])
            payload = next((p for kw, p in self.by_keyword.items() if kw in text), {})
            if isinstance(payload, Exception):
                yield _FakeBatchResult(req["custom_id"], _FakeBatchOutcome("errored"))
            else:
                message = mock.Mock(content=[_FakeBlock(json.dumps(payload))])
                yield _FakeBatchResult(req["custom_id"], _FakeBatchOutcome("succeeded", message))


class _FakeBatchClient:
    def __init__(self, by_keyword):
        self.messages = mock.Mock(batches=_FakeBatches(by_keyword))


class ParseEnrichmentTests(unittest.TestCase):
    def test_valid_payload_maps_to_camelcase(self):
        out = parse_enrichment({
            "brand": "DeWalt",
            "model_or_sku": "DCD771",
            "condition": "used",
            "product_url": "https://www.dewalt.com/product/dcd771",
            "confidence": "high",
        })
        self.assertEqual(out["brand"], "DeWalt")
        self.assertEqual(out["modelOrSku"], "DCD771")
        self.assertEqual(out["condition"], "used")
        self.assertEqual(out["productUrl"], "https://www.dewalt.com/product/dcd771")
        self.assertEqual(out["enrichmentConfidence"], "high")

    def test_invalid_enum_values_are_dropped(self):
        out = parse_enrichment({"condition": "mint", "confidence": "certain"})
        self.assertEqual(out["condition"], "")
        self.assertEqual(out["enrichmentConfidence"], "")

    def test_non_http_product_url_is_dropped(self):
        # Guards against hallucinated / relative URLs reaching the UI.
        out = parse_enrichment({"product_url": "dewalt.com/dcd771"})
        self.assertEqual(out["productUrl"], "")

    def test_per_field_confidence_maps_and_takes_max(self):
        # A confident brand with an unreadable SKU: keep both, overall = max, so
        # the lot still clears the medium/high bar (more data gets surfaced).
        out = parse_enrichment({
            "brand": "DeWalt", "model_or_sku": "",
            "condition": "used", "product_url": "",
            "brand_confidence": "high", "model_confidence": "low",
        })
        self.assertEqual(out["brandConfidence"], "high")
        self.assertEqual(out["modelConfidence"], "low")
        self.assertEqual(out["enrichmentConfidence"], "high")

    def test_v3_search_fields_map(self):
        out = parse_enrichment({
            "brand": "KitchenAid", "model_name": "Artisan",
            "product_type": "stand mixer",
            "search_query": "KitchenAid Artisan 5 qt stand mixer",
            "condition": "used", "product_url": "",
            "brand_confidence": "high", "model_confidence": "medium",
        })
        self.assertEqual(out["brand"], "KitchenAid")
        self.assertEqual(out["modelOrSku"], "Artisan")  # model_name → modelOrSku
        self.assertEqual(out["productType"], "stand mixer")
        self.assertEqual(out["searchQuery"], "KitchenAid Artisan 5 qt stand mixer")
        self.assertEqual(out["enrichmentConfidence"], "high")

    def test_v4_lot_fields_map(self):
        out = parse_enrichment({
            "brand": "Pyrex", "model_name": "", "product_type": "mixing bowl",
            "search_query": "Pyrex glass mixing bowl",
            "quantity": 12, "is_mixed_lot": False,
            "condition": "used", "condition_flags": ["damaged", "untested", "bogus"],
            "key_attributes": ["glass", "3 qt", "", "vintage", "a", "b", "c", "d"],
            "product_url": "", "brand_confidence": "high", "model_confidence": "low",
        })
        self.assertEqual(out["quantity"], "12")
        self.assertEqual(out["isMixedLot"], "false")
        # invalid flag dropped, order + dedup preserved
        self.assertEqual(json.loads(out["conditionFlags"]), ["damaged", "untested"])
        # capped at MAX_KEY_ATTRIBUTES, empties removed
        self.assertEqual(len(json.loads(out["keyAttributes"])), 6)

    def test_secondary_items_multi_brand_lot(self):
        out = parse_enrichment({
            "brand": "DeWalt", "model_name": "DCD771", "product_type": "drill",
            "search_query": "DeWalt DCD771 cordless drill",
            "is_mixed_lot": True, "quantity": 3,
            "secondary_items": [
                {"brand": "Milwaukee", "model_name": "M18", "product_type": "circular saw",
                 "search_query": "Milwaukee M18 circular saw"},
                {"brand": "", "model_name": "", "product_type": "", "search_query": ""},  # dropped
                {"brand": "Ryobi", "model_name": "", "product_type": "sander",
                 "search_query": "Ryobi orbital sander"},
            ],
            "condition": "used", "condition_flags": [], "key_attributes": [],
            "brand_confidence": "high", "model_confidence": "high",
        })
        items = json.loads(out["secondaryItems"])
        self.assertEqual([i["brand"] for i in items], ["Milwaukee", "Ryobi"])  # empty dropped
        self.assertEqual(items[0]["modelOrSku"], "M18")  # model_name -> modelOrSku
        self.assertEqual(items[1]["searchQuery"], "Ryobi orbital sander")

    def test_secondary_items_empty_when_single_product(self):
        out = parse_enrichment({
            "brand": "Pyrex", "product_type": "bowl", "search_query": "Pyrex bowl",
            "secondary_items": [], "condition": "used",
            "brand_confidence": "high", "model_confidence": "low",
        })
        self.assertEqual(out["secondaryItems"], "")

    def test_v4_mixed_lot_and_indeterminate_quantity(self):
        out = parse_enrichment({
            "brand": "", "product_type": "assorted items", "search_query": "",
            "quantity": 0, "is_mixed_lot": True,
            "condition": "used", "condition_flags": [], "key_attributes": [],
            "brand_confidence": "low", "model_confidence": "low",
        })
        self.assertEqual(out["quantity"], "")          # 0 -> indeterminate
        self.assertEqual(out["isMixedLot"], "true")
        self.assertEqual(out["conditionFlags"], "")    # empty list -> ""
        self.assertEqual(out["keyAttributes"], "")

    def test_legacy_single_confidence_still_parsed(self):
        # Older cached rows carried one `confidence`; it backfills both fields.
        out = parse_enrichment({"brand": "X", "model_or_sku": "Y", "confidence": "medium"})
        self.assertEqual(out["brandConfidence"], "medium")
        self.assertEqual(out["modelConfidence"], "medium")
        self.assertEqual(out["enrichmentConfidence"], "medium")

    def test_non_dict_returns_all_empty(self):
        out = parse_enrichment("nope")
        self.assertEqual(set(out), set(enrich.ENRICHMENT_FIELDS))
        self.assertTrue(all(value == "" for value in out.values()))


class PromptShapeTests(unittest.TestCase):
    def test_placeholder_title_is_skipped(self):
        text = item_prompt_text({"title": "Lot - 207", "description": "Brass trumpet"})
        self.assertNotIn("Lot - 207", text)
        self.assertIn("Brass trumpet", text)

    def test_real_title_is_kept(self):
        text = item_prompt_text({"title": "KitchenAid Mixer", "description": ""})
        self.assertIn("KitchenAid Mixer", text)

    def test_item_images_accepts_array_and_json_string(self):
        self.assertEqual(item_images({"images": ["https://a/1.jpg"]}), ["https://a/1.jpg"])
        self.assertEqual(item_images({"images": json.dumps(["https://a/1.jpg"])}), ["https://a/1.jpg"])
        self.assertEqual(item_images({"images": "not-json"}), [])

    def test_build_content_includes_image_block_when_url_present(self):
        content = build_content({"title": "Drill", "images": ["https://img/1.jpg"]})
        self.assertEqual(content[0]["type"], "image")
        self.assertEqual(content[0]["source"], {"type": "url", "url": "https://img/1.jpg"})
        self.assertEqual(content[-1]["type"], "text")

    def test_build_content_is_text_only_without_images(self):
        content = build_content({"title": "Drill", "images": []})
        self.assertEqual(len(content), 1)
        self.assertEqual(content[0]["type"], "text")

    def test_build_content_includes_up_to_max_images(self):
        # #152: feed the first few photos, not just one (capped at MAX_IMAGES).
        item = {"title": "Drill", "images": [f"https://img/{n}.jpg" for n in range(5)]}
        content = build_content(item)
        image_blocks = [b for b in content if b["type"] == "image"]
        self.assertEqual(len(image_blocks), enrich.MAX_IMAGES)
        self.assertEqual(content[-1]["type"], "text")

    def test_item_image_urls_filters_non_http_and_respects_limit(self):
        item = {"images": ["ftp://x/1.jpg", "https://img/1.jpg", "https://img/2.jpg"]}
        self.assertEqual(enrich.item_image_urls(item, limit=5), ["https://img/1.jpg", "https://img/2.jpg"])
        self.assertEqual(enrich.item_image_urls(item, limit=1), ["https://img/1.jpg"])


class EnablementTests(unittest.TestCase):
    def test_requires_both_optin_and_key(self):
        with mock.patch.dict("os.environ", {"GOONERS_ENRICHMENT": "1"}, clear=False):
            with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}, clear=False):
                self.assertFalse(is_enrichment_enabled())
        with mock.patch.dict("os.environ", {"GOONERS_ENRICHMENT": "0", "ANTHROPIC_API_KEY": "sk"}, clear=False):
            self.assertFalse(is_enrichment_enabled())
        with mock.patch.dict("os.environ", {"GOONERS_ENRICHMENT": "1", "ANTHROPIC_API_KEY": "sk"}, clear=False):
            self.assertTrue(is_enrichment_enabled())


class EnrichItemsTests(unittest.TestCase):
    def test_disabled_is_a_noop(self):
        items = [{"id": "1", "title": "Drill"}]
        # No client passed and enrichment disabled (conftest clears the env).
        self.assertEqual(enrich_items(items), 0)
        self.assertNotIn("brand", items[0])

    def test_injected_client_applies_fields_and_isolates_failures(self):
        items = [
            {"id": "good", "title": "DeWalt DCD771 drill", "images": []},
            {"id": "bad", "title": "explodes", "images": []},
        ]
        client = _FakeClient({
            "DeWalt DCD771 drill": {
                "brand": "DeWalt",
                "model_or_sku": "DCD771",
                "condition": "used",
                "product_url": "",
                "confidence": "high",
            },
            "explodes": RuntimeError("api boom"),
        })
        enriched = enrich_items(items, client=client)
        self.assertEqual(enriched, 1)

        good = next(i for i in items if i["id"] == "good")
        bad = next(i for i in items if i["id"] == "bad")
        self.assertEqual(good["brand"], "DeWalt")
        self.assertEqual(good["modelOrSku"], "DCD771")
        self.assertEqual(good["enrichmentConfidence"], "high")
        # The failed lot still carries the seeded empty fields (consistent schema).
        for field in enrich.ENRICHMENT_FIELDS:
            self.assertEqual(bad[field], "")


class FingerprintTests(unittest.TestCase):
    def test_stable_for_identical_inputs(self):
        a = {"title": "DeWalt DCD771", "description": "drill", "images": ["https://i/1.jpg"]}
        b = {"title": "DeWalt DCD771", "description": "drill", "images": ["https://i/1.jpg"]}
        self.assertEqual(enrichment_fingerprint(a), enrichment_fingerprint(b))

    def test_changes_when_text_or_image_changes(self):
        base = {"title": "DeWalt DCD771", "images": ["https://i/1.jpg"]}
        self.assertNotEqual(
            enrichment_fingerprint(base),
            enrichment_fingerprint({**base, "title": "DeWalt DCD999"}),
        )
        self.assertNotEqual(
            enrichment_fingerprint(base),
            enrichment_fingerprint({**base, "images": ["https://i/2.jpg"]}),
        )

    def test_changes_with_model(self):
        item = {"title": "Drill", "images": []}
        before = enrichment_fingerprint(item)
        with mock.patch.object(enrich, "MODEL", "some-other-model"):
            self.assertNotEqual(before, enrichment_fingerprint(item))


class IncrementalReuseTests(unittest.TestCase):
    def _client(self):
        return _FakeClient({
            "DeWalt DCD771 drill": {
                "brand": "DeWalt", "model_or_sku": "DCD771",
                "condition": "used", "product_url": "", "confidence": "high",
            },
        })

    def test_unchanged_lot_is_reused_without_api_call(self):
        item = {"id": "good", "title": "DeWalt DCD771 drill", "images": []}
        client = self._client()
        # First pass enriches and stamps the fingerprint.
        enrich_items([item], client=client)
        self.assertEqual(client.messages.calls, 1)
        prior_by_id = {"good": dict(item)}

        # Second pass with an identical lot reuses the prior row — no new call.
        fresh = {"id": "good", "title": "DeWalt DCD771 drill", "images": []}
        client2 = self._client()
        enrich_items([fresh], client=client2, prior_by_id=prior_by_id)
        self.assertEqual(client2.messages.calls, 0)
        self.assertEqual(fresh["brand"], "DeWalt")
        self.assertEqual(fresh["enrichmentConfidence"], "high")

    def test_changed_lot_is_re_enriched(self):
        prior_by_id = {"good": {
            "id": "good", "brand": "DeWalt",
            "enrichmentInputHash": "stale-hash-that-wont-match",
        }}
        fresh = {"id": "good", "title": "DeWalt DCD771 drill", "images": []}
        client = self._client()
        enrich_items([fresh], client=client, prior_by_id=prior_by_id)
        self.assertEqual(client.messages.calls, 1)

    def test_empty_result_is_still_cached(self):
        # A generic lot the model can't identify still gets a fingerprint, so it
        # isn't re-called every scrape (the junk majority is the whole point).
        item = {"id": "junk", "title": "Lot - 207", "description": "assorted", "images": []}
        client = _FakeClient({})  # falls through to {} → all-empty enrichment
        enrich_items([item], client=client)
        self.assertTrue(item["enrichmentInputHash"])

        prior_by_id = {"junk": dict(item)}
        fresh = {"id": "junk", "title": "Lot - 207", "description": "assorted", "images": []}
        client2 = _FakeClient({})
        enrich_items([fresh], client=client2, prior_by_id=prior_by_id)
        self.assertEqual(client2.messages.calls, 0)


class LoadPriorEnrichmentTests(unittest.TestCase):
    def test_missing_sidecar_is_empty(self):
        from pathlib import Path
        self.assertEqual(load_prior_enrichment(Path("/no/such/file.ndjson")), {})

    def test_indexes_rows_by_id(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.ndjson"
            path.write_text(
                json.dumps({"id": "1", "brand": "X"}) + "\n"
                + "\n"  # blank line tolerated
                + json.dumps({"id": "2", "brand": "Y"}) + "\n",
                encoding="utf-8",
            )
            prior = load_prior_enrichment(path)
            self.assertEqual(set(prior), {"1", "2"})
            self.assertEqual(prior["2"]["brand"], "Y")


class RateLimiterTests(unittest.TestCase):
    def test_zero_rpm_does_not_sleep(self):
        limiter = _RateLimiter(0)
        start = time.monotonic()
        for _ in range(5):
            limiter.acquire()
        self.assertLess(time.monotonic() - start, 0.05)

    def test_spaces_calls_by_min_interval(self):
        limiter = _RateLimiter(600)  # 0.1s spacing
        start = time.monotonic()
        for _ in range(3):  # first is free, then 2 × 0.1s
            limiter.acquire()
        self.assertGreaterEqual(time.monotonic() - start, 0.18)


class EnrichItemsBatchTests(unittest.TestCase):
    def setUp(self):
        # Don't actually sleep between polls in tests.
        self._patch = mock.patch.object(enrich.time, "sleep", lambda *_: None)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_disabled_is_a_noop(self):
        items = [{"id": "1", "title": "Drill"}]
        self.assertEqual(enrich_items_batch(items), 0)
        self.assertNotIn("brand", items[0])

    def test_batch_applies_results_by_custom_id(self):
        items = [
            {"id": "good", "title": "DeWalt DCD771 drill", "images": []},
            {"id": "junk", "title": "Lot - 207", "description": "assorted", "images": []},
        ]
        client = _FakeBatchClient({
            "DeWalt DCD771 drill": {
                "brand": "DeWalt", "model_or_sku": "DCD771",
                "condition": "used", "product_url": "", "confidence": "high",
            },
        })
        # Both lots are "processed" (each gets the bookkeeping fingerprint, same
        # as the synchronous path counts it); only `good` is actually identified.
        enriched = enrich_items_batch(items, client=client, poll_interval=0)
        self.assertEqual(enriched, 2)
        self.assertEqual(client.messages.batches.created, 1)

        good = next(i for i in items if i["id"] == "good")
        junk = next(i for i in items if i["id"] == "junk")
        self.assertEqual(good["brand"], "DeWalt")
        self.assertEqual(good["enrichmentConfidence"], "high")
        # Identified lots get a model stamp; the junk lot doesn't, but both get a
        # fingerprint so neither is re-called on the next backfill.
        self.assertEqual(good["enrichmentModel"], enrich.MODEL)
        self.assertEqual(junk["enrichmentModel"], "")
        self.assertTrue(good["enrichmentInputHash"])
        self.assertTrue(junk["enrichmentInputHash"])

    def test_errored_result_is_isolated(self):
        items = [
            {"id": "good", "title": "DeWalt DCD771 drill", "images": []},
            {"id": "bad", "title": "explodes", "images": []},
        ]
        client = _FakeBatchClient({
            "DeWalt DCD771 drill": {
                "brand": "DeWalt", "model_or_sku": "DCD771",
                "condition": "used", "product_url": "", "confidence": "high",
            },
            "explodes": RuntimeError("server error"),
        })
        enriched = enrich_items_batch(items, client=client, poll_interval=0)
        self.assertEqual(enriched, 1)
        bad = next(i for i in items if i["id"] == "bad")
        # The errored lot keeps seeded empty fields and no fingerprint, so a later
        # backfill retries it.
        for field in enrich.ENRICHMENT_FIELDS:
            self.assertEqual(bad[field], "")

    def test_unchanged_lots_skip_the_batch(self):
        # A lot whose fingerprint matches the prior row is reused without ever
        # being submitted — when every lot is reused, no batch is created.
        item = {"id": "good", "title": "DeWalt DCD771 drill", "images": []}
        seed_client = _FakeBatchClient({
            "DeWalt DCD771 drill": {
                "brand": "DeWalt", "model_or_sku": "DCD771",
                "condition": "used", "product_url": "", "confidence": "high",
            },
        })
        enrich_items_batch([item], client=seed_client, poll_interval=0)
        prior_by_id = {"good": dict(item)}

        fresh = {"id": "good", "title": "DeWalt DCD771 drill", "images": []}
        client2 = _FakeBatchClient({})
        enrich_items_batch([fresh], client=client2, prior_by_id=prior_by_id, poll_interval=0)
        self.assertEqual(client2.messages.batches.created, 0)
        self.assertEqual(fresh["brand"], "DeWalt")

    def test_chunks_when_over_batch_size(self):
        items = [
            {"id": str(n), "title": f"DeWalt DCD771 unit {n}", "images": []}
            for n in range(5)
        ]
        client = _FakeBatchClient({"DeWalt DCD771": {
            "brand": "DeWalt", "model_or_sku": "DCD771",
            "condition": "used", "product_url": "", "confidence": "high",
        }})
        # Inline path (default) chunks at BATCH_INLINE_MAX_REQUESTS.
        with mock.patch.object(enrich, "BATCH_INLINE_MAX_REQUESTS", 2):
            enriched = enrich_items_batch(items, client=client, poll_interval=0)
        self.assertEqual(enriched, 5)
        # 5 lots / 2 per batch → 3 submissions.
        self.assertEqual(client.messages.batches.created, 3)

    def test_inline_images_are_fetched_and_base64_encoded(self):
        # With inline_images (the default), the photo is downloaded + downscaled
        # and sent as a base64 block — no image URL reaches the request, so
        # Anthropic never does a server-side fetch (the 100 RPM URL-fetch limit).
        items = [{"id": "good", "title": "DeWalt DCD771 drill",
                  "images": ["https://img/1.jpg"]}]
        client = _FakeBatchClient({"DeWalt DCD771 drill": {
            "brand": "DeWalt", "model_or_sku": "DCD771",
            "condition": "used", "product_url": "", "confidence": "high",
        }})
        with mock.patch.object(enrich, "fetch_image_base64", lambda url: ("image/jpeg", "ZmFrZQ==")):
            enrich_items_batch(items, client=client, poll_interval=0)
        req = client.messages.batches._requests[0]
        blocks = req["params"]["messages"][0]["content"]
        image_blocks = [b for b in blocks if b.get("type") == "image"]
        self.assertEqual(len(image_blocks), 1)
        self.assertEqual(image_blocks[0]["source"]["type"], "base64")
        self.assertEqual(image_blocks[0]["source"]["data"], "ZmFrZQ==")
        self.assertEqual(items[0]["brand"], "DeWalt")

    def test_inline_image_fetch_failure_falls_back_to_text_only(self):
        items = [{"id": "good", "title": "DeWalt DCD771 drill",
                  "images": ["https://img/gone.jpg"]}]
        client = _FakeBatchClient({"DeWalt DCD771 drill": {
            "brand": "DeWalt", "model_or_sku": "DCD771",
            "condition": "used", "product_url": "", "confidence": "high",
        }})
        with mock.patch.object(enrich, "fetch_image_base64", lambda url: None):
            enriched = enrich_items_batch(items, client=client, poll_interval=0)
        req = client.messages.batches._requests[0]
        blocks = req["params"]["messages"][0]["content"]
        self.assertFalse([b for b in blocks if b.get("type") == "image"])  # text-only
        self.assertEqual(enriched, 1)  # still enriched from the text


class EbayQueryFromEnrichmentTests(unittest.TestCase):
    def test_search_query_used_unquoted_when_confident(self):
        from ebay_query import enriched_exact_phrase
        item = {"enrichmentConfidence": "high", "brand": "KitchenAid",
                "modelOrSku": "Artisan", "searchQuery": "KitchenAid Artisan 5 qt stand mixer"}
        self.assertEqual(enriched_exact_phrase(item), "KitchenAid Artisan 5 qt stand mixer")

    def test_low_confidence_yields_no_enriched_query(self):
        from ebay_query import enriched_exact_phrase
        item = {"enrichmentConfidence": "low", "searchQuery": "whatever it is"}
        self.assertEqual(enriched_exact_phrase(item), "")

    def test_falls_back_to_quoted_brand_model_without_search_query(self):
        from ebay_query import enriched_exact_phrase
        item = {"enrichmentConfidence": "high", "brand": "DeWalt", "modelOrSku": "DCD771"}
        self.assertEqual(enriched_exact_phrase(item), '"DeWalt DCD771"')


class EnrichmentSummaryTests(unittest.TestCase):
    def test_counts_identified_vs_processed(self):
        rows = [
            {"enrichmentConfidence": "high", "brand": "DeWalt", "modelOrSku": "DCD771"},
            {"enrichmentConfidence": "medium", "brand": "Delta", "modelOrSku": ""},
            {"enrichmentConfidence": "low", "brand": "", "modelOrSku": ""},
            {"enrichmentConfidence": "", "brand": "", "modelOrSku": ""},  # processed, unidentified
        ]
        s = enrich.enrichment_summary(rows)
        self.assertEqual(s["total"], 4)
        self.assertEqual(s["identified"], 2)  # high + medium only
        self.assertEqual((s["high"], s["medium"], s["low"], s["none"]), (1, 1, 1, 1))
        self.assertEqual(s["brand"], 2)
        self.assertEqual(s["model"], 1)

    def test_format_includes_percentage(self):
        line = enrich.format_enrichment_summary("a1", enrich.enrichment_summary([
            {"enrichmentConfidence": "high", "brand": "X", "modelOrSku": "Y"},
            {"enrichmentConfidence": "low"},
        ]))
        self.assertIn("a1: 1/2 identified (50%)", line)


class BackfillTargetTests(unittest.TestCase):
    def _dirs(self, tmp):
        active = Path(tmp) / "items"
        archive = Path(tmp) / "archive" / "items"
        active.mkdir(parents=True)
        archive.mkdir(parents=True)
        (active / "a1.ndjson").write_text("{}\n", encoding="utf-8")
        (archive / "old1.ndjson").write_text("{}\n", encoding="utf-8")
        # Same id present in both — active should win, listed once.
        (active / "dup.ndjson").write_text("{}\n", encoding="utf-8")
        (archive / "dup.ndjson").write_text("{}\n", encoding="utf-8")
        return active, archive

    def test_all_spans_active_and_archive_deduped(self):
        with tempfile.TemporaryDirectory() as tmp:
            active, archive = self._dirs(tmp)
            with mock.patch.object(enrich, "_backfill_dirs", lambda: [active, archive]):
                targets = enrich._resolve_backfill_targets([], include_all=True)
        ids = [safe_id for _, safe_id in targets]
        self.assertEqual(sorted(ids), ["a1", "dup", "old1"])
        # `dup` resolves to the active dir (active wins).
        self.assertEqual(dict((s, d) for d, s in targets)["dup"], active)

    def test_named_id_resolves_in_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            active, archive = self._dirs(tmp)
            with mock.patch.object(enrich, "_backfill_dirs", lambda: [active, archive]):
                targets = enrich._resolve_backfill_targets(["old1"], include_all=False)
        self.assertEqual(targets, [(archive, "old1")])

    def test_unknown_id_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            active, archive = self._dirs(tmp)
            with mock.patch.object(enrich, "_backfill_dirs", lambda: [active, archive]):
                targets = enrich._resolve_backfill_targets(["nope"], include_all=False)
        self.assertEqual(targets, [])


class BackfillRunTests(unittest.TestCase):
    def test_all_enriches_writes_and_mirrors(self):
        # Two auctions (one active, one archive); --batch --all should enrich the
        # combined lots once, rewrite each file, and mirror to Supabase.
        with tempfile.TemporaryDirectory() as tmp:
            active = Path(tmp) / "items"
            archive = Path(tmp) / "archive" / "items"
            active.mkdir(parents=True)
            archive.mkdir(parents=True)
            (active / "a1.ndjson").write_text(
                json.dumps({"id": "x", "title": "DeWalt DCD771 drill", "images": []}) + "\n",
                encoding="utf-8",
            )
            (archive / "old1.ndjson").write_text(
                json.dumps({"id": "y", "title": "DeWalt DCD771 saw", "images": []}) + "\n",
                encoding="utf-8",
            )

            client = _FakeBatchClient({"DeWalt DCD771": {
                "brand": "DeWalt", "model_or_sku": "DCD771",
                "condition": "used", "product_url": "", "confidence": "high",
            }})
            writes = []
            mirrored = []
            fake_supabase = types.ModuleType("supabase_enrichment")
            fake_supabase.maybe_export_enrichment = lambda rows: mirrored.append(list(rows))

            with mock.patch.object(enrich, "_backfill_dirs", lambda: [active, archive]), \
                 mock.patch.object(enrich, "is_enrichment_enabled", lambda: True), \
                 mock.patch.object(enrich, "_make_client", lambda: client), \
                 mock.patch.object(enrich, "_write_rows", lambda d, s, rows: writes.append((d, s, len(rows)))), \
                 mock.patch.object(enrich.time, "sleep", lambda *_: None), \
                 mock.patch.dict(sys.modules, {"supabase_enrichment": fake_supabase}):
                rc = enrich._backfill([], use_batch=True, include_all=True)

        self.assertEqual(rc, 0)
        # Per-auction (durable/resumable): one batch + one write + one mirror each.
        self.assertEqual(client.messages.batches.created, 2)
        self.assertEqual(sorted(s for _, s, _ in writes), ["a1", "old1"])
        self.assertEqual(len(mirrored), 2)
        self.assertEqual(sum(len(m) for m in mirrored), 2)
        self.assertTrue(all(row["brand"] == "DeWalt" for m in mirrored for row in m))


    def test_rerun_resumes_skipping_already_enriched(self):
        # An on-disk auction whose lots already carry a matching input hash is
        # reused on rerun — no batch is created, so a resumed backfill doesn't
        # re-bill finished auctions.
        with tempfile.TemporaryDirectory() as tmp:
            active = Path(tmp) / "items"
            active.mkdir(parents=True)
            row = {"id": "x", "title": "DeWalt DCD771 drill", "images": [],
                   "brand": "DeWalt", "modelOrSku": "DCD771", "condition": "used",
                   "productUrl": "", "enrichmentConfidence": "high",
                   "enrichmentModel": enrich.MODEL}
            row["enrichmentInputHash"] = enrich.enrichment_fingerprint(row)
            (active / "done1.ndjson").write_text(json.dumps(row) + "\n", encoding="utf-8")

            client = _FakeBatchClient({})  # would error if any lot were submitted
            fake_supabase = types.ModuleType("supabase_enrichment")
            fake_supabase.maybe_export_enrichment = lambda rows: None

            with mock.patch.object(enrich, "_backfill_dirs", lambda: [active]), \
                 mock.patch.object(enrich, "is_enrichment_enabled", lambda: True), \
                 mock.patch.object(enrich, "_make_client", lambda: client), \
                 mock.patch.object(enrich, "_write_rows", lambda *a: None), \
                 mock.patch.object(enrich.time, "sleep", lambda *_: None), \
                 mock.patch.dict(sys.modules, {"supabase_enrichment": fake_supabase}):
                rc = enrich._backfill([], use_batch=True, include_all=True)

        self.assertEqual(rc, 0)
        self.assertEqual(client.messages.batches.created, 0)  # nothing re-submitted


if __name__ == "__main__":
    unittest.main()
