"""Thin GitHub REST client for the stats pipeline — pagination + log download.

Just enough of the GitHub API to feed the dlt resources in ``pipeline.py``:
Link-header pagination, a bearer token from the environment, and a helper that
downloads a workflow run's log zip and returns its combined text for
``transforms.parse_log_metrics``. No third-party deps beyond ``requests``.
"""

from __future__ import annotations

import io
import os
import time
import zipfile
from collections.abc import Iterator

import requests

API_ROOT = "https://api.github.com"
DEFAULT_REPO = "dataders/james-river-gooners"
# GitHub caps list endpoints at 100 per page.
PER_PAGE = 100


def resolve_repo(repo: str | None = None) -> str:
    """Repo as ``owner/name`` — explicit arg, else ``GITHUB_REPOSITORY`` (set in
    Actions), else the project default."""
    return repo or os.environ.get("GITHUB_REPOSITORY") or DEFAULT_REPO


def resolve_token(token: str | None = None) -> str | None:
    """Token from arg or the usual env vars (``GITHUB_TOKEN`` in Actions, ``GH_TOKEN`` locally)."""
    return token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


class GitHubClient:
    """Authenticated, rate-limit-aware GitHub REST client."""

    def __init__(self, repo: str | None = None, token: str | None = None, session=None):
        self.repo = resolve_repo(repo)
        self.token = resolve_token(token)
        self.session = session or requests.Session()
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "james-river-gooners-stats",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        self.session.headers.update(headers)

    def _get(self, url: str, params: dict | None = None) -> requests.Response:
        """GET with one retry on a primary rate-limit (403 + remaining 0) by
        sleeping to the reset, and a short backoff on 5xx."""
        for attempt in range(5):
            resp = self.session.get(url, params=params, timeout=30)
            if resp.status_code == 403 and resp.headers.get("X-RateLimit-Remaining") == "0":
                reset = int(resp.headers.get("X-RateLimit-Reset", "0"))
                wait = max(0, reset - int(time.time())) + 1
                # Cap the sleep so a pathological reset can't hang CI forever.
                time.sleep(min(wait, 300))
                continue
            if resp.status_code >= 500 and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            return resp
        return resp

    def paginate(self, path: str, params: dict | None = None) -> Iterator[dict]:
        """Yield items across all pages of a list endpoint via the Link header.

        Works for endpoints that return a bare array (issues, pulls, commits).
        """
        url = f"{API_ROOT}/repos/{self.repo}/{path}"
        params = {**(params or {}), "per_page": PER_PAGE}
        while url:
            resp = self._get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            if not isinstance(data, list):
                return
            yield from data
            url = resp.links.get("next", {}).get("url")
            # The "next" URL already carries page+per_page; don't re-send params.
            params = None

    def paginate_wrapped(self, path: str, key: str, params: dict | None = None) -> Iterator[dict]:
        """Like :meth:`paginate` but for endpoints that wrap the array in an
        object under ``key`` (e.g. ``/actions/runs`` → ``{"workflow_runs": [...]}``)."""
        url = f"{API_ROOT}/repos/{self.repo}/{path}"
        params = {**(params or {}), "per_page": PER_PAGE}
        while url:
            resp = self._get(url, params=params)
            resp.raise_for_status()
            payload = resp.json()
            items = payload.get(key, []) if isinstance(payload, dict) else []
            if not items:
                return
            yield from items
            url = resp.links.get("next", {}).get("url")
            params = None

    def run_log_text(self, run_id: int) -> str:
        """Download a workflow run's logs (a zip of per-step text files) and return
        the concatenated text, or ``""`` if logs are unavailable (404 once GitHub
        expires them, or the run isn't finished)."""
        url = f"{API_ROOT}/repos/{self.repo}/actions/runs/{run_id}/logs"
        resp = self._get(url)
        if resp.status_code == 404:
            return ""
        resp.raise_for_status()
        try:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                parts = []
                for name in zf.namelist():
                    if name.endswith(".txt"):
                        parts.append(zf.read(name).decode("utf-8", errors="replace"))
                return "\n".join(parts)
        except zipfile.BadZipFile:
            return ""
