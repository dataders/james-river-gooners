"""Client for Supabase's privileged Prometheus metrics endpoint.

Supabase exposes per-project infrastructure metrics in Prometheus text format at
``https://<ref>.supabase.co/customer/v1/privileged/metrics``, gated by HTTP Basic
auth (username ``service_role``, password = the project's service-role
credential). This is the canonical reliability/load/performance source — host
CPU/RAM/disk, database internals, and the service layer.

Config (all via env; explicit args win):
- ``SUPABASE_METRICS_URL`` — full metrics URL. If unset, derived from
  ``SUPABASE_URL`` (``https://<ref>.supabase.co``) + the privileged path.
- ``SUPABASE_METRICS_PASSWORD`` — the Basic-auth password. Falls back to
  ``SUPABASE_SERVICE_ROLE_KEY`` / ``SUPABASE_SECRET_KEY`` (the project's
  service-role credential), so existing CI secrets work without a new one.
- ``SUPABASE_METRICS_USERNAME`` — Basic-auth username (default ``service_role``).

The HTTP session is injectable so the parser/client can be tested against a fake
session with no network.
"""

from __future__ import annotations

import os
from typing import Protocol
from urllib.parse import urlparse, urlunparse

PRIVILEGED_METRICS_PATH = "/customer/v1/privileged/metrics"
DEFAULT_USERNAME = "service_role"
DEFAULT_TIMEOUT = 30


class _Response(Protocol):
    status_code: int
    text: str

    def raise_for_status(self) -> object: ...


class _Session(Protocol):
    def get(self, url: str, **kwargs) -> _Response: ...


def _derive_metrics_url(explicit: str | None, supabase_url: str | None) -> str | None:
    """Resolve the metrics URL from an explicit value or a Supabase project URL."""
    if explicit:
        return explicit
    if not supabase_url:
        return None
    parsed = urlparse(
        supabase_url if "//" in supabase_url else f"https://{supabase_url}"
    )
    # Replace whatever path was on SUPABASE_URL with the privileged metrics path.
    return urlunparse(
        parsed._replace(path=PRIVILEGED_METRICS_PATH, params="", query="", fragment="")
    )


def make_session() -> _Session:
    """Real requests.Session (imported lazily so tests need no requests)."""
    import requests

    session = requests.Session()
    session.headers.update(
        {"Accept": "text/plain", "User-Agent": "gooners-supabase-stats/1.0"}
    )
    return session


class SupabaseMetricsClient:
    """Fetches the privileged Prometheus metrics text for one project."""

    def __init__(
        self,
        *,
        url: str | None = None,
        username: str | None = None,
        password: str | None = None,
        session: _Session | None = None,
        timeout: int = DEFAULT_TIMEOUT,
    ):
        self.url = _derive_metrics_url(
            url or os.environ.get("SUPABASE_METRICS_URL"),
            os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL"),
        )
        self.username = (
            username or os.environ.get("SUPABASE_METRICS_USERNAME") or DEFAULT_USERNAME
        )
        self.password = (
            password
            or os.environ.get("SUPABASE_METRICS_PASSWORD")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or os.environ.get("SUPABASE_SECRET_KEY")
        )
        self.timeout = timeout
        self._session = session

    @property
    def configured(self) -> bool:
        return bool(self.url and self.password)

    def missing_config_message(self) -> str:
        missing = []
        if not self.url:
            missing.append("SUPABASE_METRICS_URL (or SUPABASE_URL to derive it)")
        if not self.password:
            missing.append(
                "SUPABASE_METRICS_PASSWORD (or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY)"
            )
        return "Missing Supabase metrics config: " + ", ".join(missing)

    @property
    def session(self) -> _Session:
        if self._session is None:
            self._session = make_session()
        return self._session

    def fetch_metrics_text(self) -> str:
        """GET the privileged metrics endpoint and return the raw Prometheus text."""
        if not self.configured:
            raise RuntimeError(self.missing_config_message())
        assert self.url is not None  # narrowed by `configured`
        resp = self.session.get(
            self.url,
            auth=(self.username, self.password),
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.text
