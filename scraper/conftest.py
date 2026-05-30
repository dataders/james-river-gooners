"""Shared pytest fixtures for the scraper test suite.

The comp/scrape code branches on a handful of environment variables (the
SoldComps API key, MotherDuck tokens, and various GOONERS_* overrides). When
those happen to be set in a developer's shell — as they are in the cloud dev
environment — they silently change which code path runs and make hermetic unit
tests fail (e.g. fetch_sold_matches hits the live API instead of the stubbed
HTML scraper). Clear them for every test so the suite is deterministic and
matches CI, where the secrets are absent.
"""

import pytest

# Env vars that alter runtime behavior and must not leak into unit tests.
_ISOLATED_ENV_VARS = (
    "SOLDCOMPS_API_KEY",
    "SOLDCOMPS_API_URL",
    "MOTHERDUCK_TOKEN",
    "MOTHERDUCK_READ_TOKEN",
    "GOONERS_MOTHERDUCK_SNAPSHOTS",
    "GOONERS_EBAY_COMPS_LIMIT",
    "GOONERS_EBAY_COMPS_MAX_QUERIES",
    "GOONERS_EBAY_COMPS_MONTHLY_BUDGET",
    "GOONERS_EBAY_USER_AGENT",
    "GOONERS_EBAY_BROWSER_FALLBACK",
)


@pytest.fixture(autouse=True)
def _isolate_env(monkeypatch):
    """Remove behavior-changing env vars so tests run against the defaults."""
    for name in _ISOLATED_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
