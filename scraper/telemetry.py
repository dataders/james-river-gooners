"""Server-side PostHog telemetry for the scraper.

Instruments (1) the metered SoldComps API calls (``scraper/ebay_fetch.py``) so the
real billed-request count and the provider's reported remaining quota (the
``X-Usage-*`` response headers) land in PostHog — that call site is the one
chokepoint every billed request passes through, regardless of which workflow,
manual dispatch, or local run made it, which is exactly why the Supabase comp
ledger (which counts *attempts*, including free HTML-scrape fallbacks and
no-result rows) cannot be reconciled with the provider's meter on its own — and
(2) the LLM enrichment runs (``scraper/enrich.py``): ``enrich_batch_submitted`` /
``enrich_batch_completed`` (with token counts + estimated cost) / ``enrich_batch_failed``
on the Message Batches path, and ``enrich_sync_completed`` on the live path.

Gating mirrors ``src/lib/telemetry.js`` and ``enrich.py``: a silent no-op unless
``GOONERS_POSTHOG_KEY`` is set AND the ``posthog`` SDK imports. It never raises
into the caller — telemetry must not crash a scrape. The key is the project's
write-only ingestion key (the same browser-safe value behind ``VITE_POSTHOG_KEY``),
exposed here under a non-``VITE_`` name so it stays out of the frontend bundle.
"""

from __future__ import annotations

import atexit
import os

# These are infrastructure events, not user analytics, so they share one
# constant identity and never create a person profile.
_DISTINCT_ID = "gooners-scraper"
_DEFAULT_HOST = "https://us.i.posthog.com"

_client = None
_init_attempted = False


def _api_key() -> str:
    return (os.environ.get("GOONERS_POSTHOG_KEY") or "").strip()


def is_telemetry_configured() -> bool:
    """True when an ingestion key is present (the SDK import is checked lazily)."""
    return bool(_api_key())


def _get_client():
    """Lazily build the PostHog client once; return None when unconfigured."""
    global _client, _init_attempted
    if _init_attempted:
        return _client
    _init_attempted = True
    key = _api_key()
    if not key:
        return None
    try:
        from posthog import Posthog
    except Exception:
        return None
    try:
        _client = Posthog(
            project_api_key=key,
            host=(os.environ.get("GOONERS_POSTHOG_HOST") or _DEFAULT_HOST).strip(),
        )
    except Exception:
        _client = None
        return None
    atexit.register(flush)
    return _client


def _run_context() -> dict:
    """GitHub Actions run identifiers, when present, to tie events to a run."""
    ctx = {}
    for prop, env in (
        ("run_id", "GITHUB_RUN_ID"),
        ("run_attempt", "GITHUB_RUN_ATTEMPT"),
        ("workflow", "GITHUB_WORKFLOW"),
    ):
        value = os.environ.get(env)
        if value:
            ctx[prop] = value
    return ctx


def capture(event: str, properties: dict | None = None) -> None:
    """Best-effort PostHog capture. Never raises into the caller."""
    client = _get_client()
    if client is None:
        return
    props = {
        # Count the event, but never build a person profile for the scraper.
        "$process_person_profile": False,
        **_run_context(),
        **(properties or {}),
    }
    try:
        client.capture(event=event, distinct_id=_DISTINCT_ID, properties=props)
    except TypeError:
        # The positional order of capture() changed across posthog majors;
        # fall back to the older (distinct_id, event) signature.
        try:
            client.capture(_DISTINCT_ID, event, properties=props)
        except Exception:
            pass
    except Exception:
        pass


def flush() -> None:
    """Flush queued events. Safe to call when telemetry is unconfigured."""
    if _client is None:
        return
    try:
        _client.flush()
    except Exception:
        pass
