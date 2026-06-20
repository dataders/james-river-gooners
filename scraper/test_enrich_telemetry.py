"""PostHog telemetry events emitted by enrich.py's batch + sync paths.

Monkeypatches enrich._telemetry_capture (so no real PostHog client is built) and
asserts the right events + property keys fire. Reuses the fake Anthropic clients
from test_enrich. Run:
  uv run --with anthropic --with pytest python -m pytest scraper/test_enrich_telemetry.py -q
"""

import unittest
from unittest import mock

import enrich
from test_enrich import _FakeBatchClient, _FakeClient


def _items(ids):
    return [
        {"id": i, "title": f"DeWalt DCD771 drill {i}", "description": "d", "images": []}
        for i in ids
    ]


class EnrichTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        cap = mock.patch.object(
            enrich,
            "_telemetry_capture",
            side_effect=lambda event, properties=None: self.events.append(
                (event, properties or {})
            ),
        )
        cap.start()
        self.addCleanup(cap.stop)
        slp = mock.patch.object(enrich.time, "sleep", lambda *_: None)
        slp.start()
        self.addCleanup(slp.stop)

    def _by_event(self):
        return dict(self.events)

    def test_sync_path_emits_sync_completed(self):
        client = _FakeClient(
            {"DeWalt DCD771 drill": {"brand": "DeWalt", "confidence": "high"}}
        )
        enrich.enrich_items(_items(["a"]), client=client)
        events = self._by_event()
        self.assertIn("enrich_sync_completed", events)
        props = events["enrich_sync_completed"]
        self.assertEqual(props["lots"], 1)
        self.assertEqual(props["enriched"], 1)
        self.assertEqual(props["model"], "claude-haiku-4-5")

    def test_batch_path_emits_submitted_and_completed(self):
        client = _FakeBatchClient(
            {"DeWalt DCD771 drill": {"brand": "DeWalt", "confidence": "high"}}
        )
        enrich.enrich_items_batch(
            _items(["a", "b"]), client=client, poll_interval=0, inline_images=False
        )
        names = [e for e, _ in self.events]
        self.assertIn("enrich_batch_submitted", names)
        self.assertIn("enrich_batch_completed", names)
        events = self._by_event()
        submitted = events["enrich_batch_submitted"]
        self.assertEqual(submitted["lots"], 2)
        self.assertEqual(submitted["transport"], "url")
        completed = events["enrich_batch_completed"]
        self.assertEqual(completed["lots"], 2)
        for key in (
            "succeeded",
            "errored",
            "input_tokens",
            "output_tokens",
            "est_cost_usd",
            "model",
        ):
            self.assertIn(key, completed)


if __name__ == "__main__":
    unittest.main()
