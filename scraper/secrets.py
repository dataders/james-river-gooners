"""Named accessors for scraper credentials (API keys, tokens, connection strings).

Secrets are not validated settings — they have no defaults, no types to coerce,
and must never be echoed or exposed. This module centralises the ``os.environ``
reads so every credential lookup is greppable in one place rather than scattered
across the codebase as bare ``os.environ.get("ANTHROPIC_API_KEY")`` strings.

None is returned (not raised) when a credential is absent, so callers can gate
cleanly:
    if not anthropic_key():
        return  # enrichment not configured

The secret-key variables must never appear in a VITE_* env var or in committed
files. See CLAUDE.md § Environment variables.
"""

from __future__ import annotations

import os


def anthropic_key() -> str | None:
    """Anthropic API key for LLM enrichment (enrich.py)."""
    return os.environ.get("ANTHROPIC_API_KEY") or None


def supabase_url() -> str | None:
    """Supabase project URL.  Backend writers use SUPABASE_URL; falls back to
    VITE_SUPABASE_URL so a local dev shell that only has the Vite var works."""
    return (
        os.environ.get("SUPABASE_URL")
        or os.environ.get("VITE_SUPABASE_URL")
        or None
    )


def supabase_secret_key() -> str | None:
    """Service-role key (bypasses RLS).  Backend-only — never in a VITE_ var."""
    return os.environ.get("SUPABASE_SECRET_KEY") or None


def supabase_creds() -> tuple[str, str] | None:
    """Convenience accessor: (url, secret_key), or None if either is absent."""
    url = supabase_url()
    key = supabase_secret_key()
    if url and key:
        return (url, key)
    return None


def soldcomps_key() -> str | None:
    """SoldComps.com API key for paid eBay sold-comp queries."""
    return os.environ.get("SOLDCOMPS_API_KEY") or None


def apify_key() -> str | None:
    """Apify actor API token (batch eBay scraping via Apify backend)."""
    return os.environ.get("APIFY_API_KEY") or None


def motherduck_token() -> str | None:
    """MotherDuck read/write PAT for the optional listing_snapshots warehouse."""
    return os.environ.get("MOTHERDUCK_TOKEN") or None


def posthog_key() -> str | None:
    """Server-side PostHog ingestion key (write-only, same value as VITE_POSTHOG_KEY)."""
    return (os.environ.get("GOONERS_POSTHOG_KEY") or "").strip() or None
