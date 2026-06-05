import json
import unittest
from unittest import mock

import enrich
from enrich import (
    build_content,
    enrich_items,
    is_enrichment_enabled,
    item_images,
    item_prompt_text,
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


if __name__ == "__main__":
    unittest.main()
