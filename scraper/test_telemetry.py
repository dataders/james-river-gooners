import importlib
import os
import unittest
from unittest.mock import patch


class TelemetryGatingTest(unittest.TestCase):
    """Server-side PostHog telemetry is a silent no-op unless configured."""

    def tearDown(self):
        # Leave the module unconfigured so other test files see a clean state.
        with patch.dict(os.environ, {"GOONERS_POSTHOG_KEY": ""}, clear=False):
            import telemetry
            importlib.reload(telemetry)

    def test_unconfigured_is_noop_and_never_raises(self):
        with patch.dict(os.environ, {"GOONERS_POSTHOG_KEY": ""}, clear=False):
            import telemetry
            importlib.reload(telemetry)
            self.assertFalse(telemetry.is_telemetry_configured())
            # No key → capture/flush must be harmless no-ops.
            telemetry.capture("soldcomps_api_request", {"status": "ok"})
            telemetry.flush()
            self.assertIsNone(telemetry._client)

    def test_capture_swallows_sdk_errors(self):
        with patch.dict(os.environ, {"GOONERS_POSTHOG_KEY": "phc_test"}, clear=False):
            import telemetry
            importlib.reload(telemetry)
            self.assertTrue(telemetry.is_telemetry_configured())

            class Boom:
                def capture(self, *a, **k):
                    raise RuntimeError("sdk down")

                def flush(self, *a, **k):
                    pass

            with patch.object(telemetry, "_get_client", return_value=Boom()):
                # A raising client must not propagate out of capture().
                telemetry.capture("soldcomps_api_request", {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
