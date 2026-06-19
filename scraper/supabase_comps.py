"""Supabase (PostgREST) sink for eBay comp snapshots — issue #6.

Companion to ``motherduck.py``: writes the same comp snapshot row dicts the
scraper already builds (``scraper/ebay_comps.py``) to the Supabase
``ebay_comp_snapshots`` table over the PostgREST REST API. Writes use the
secret key (``SUPABASE_SECRET_KEY``), which bypasses row-level security; the
browser reads the deduplicated ``public_auction_comps`` view with the
publishable key. The secret key must never reach the browser bundle.

Selected via ``GOONERS_WAREHOUSE=supabase`` through the :mod:`warehouse` seam,
so no comp-fetch call sites change.
"""

import json
import time
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from functools import partial

import env_secrets as secrets
from config import SupabaseSettings as _SupaCfg
from ebay_ledger import CompLedger

COMP_SNAPSHOT_TABLE = "ebay_comp_snapshots"
# Reconstruction views (migration 0005) the scraper reads as its ledger.
FRESHNESS_VIEW = "comp_item_freshness"
QUERY_ATTEMPTS_VIEW = "comp_query_attempts"
# SoldComps provider quota ledger (migration 0025, issue #299): the cached
# X-Usage-* remaining readings the start gate consults as the authoritative meter.
USAGE_TABLE = "soldcomps_usage"
# PostgREST caps a response at 1000 rows; freshness reads page past it.
READ_PAGE_SIZE = 1000

# Columns written per row. `id` (identity) and `ingested_at` (default now())
# are filled by Postgres and deliberately omitted. Mirrors the MotherDuck insert
# column list in scraper/ebay_comps.py so the same row dict serializes to either.
COMP_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "status",
    "query",
    "search_url",
    "fetched_at",
    "warning",
    "ebay_item_id",
    "title",
    "price_value",
    "price_currency",
    "shipping_label",
    "sold_date",
    "sold_date_label",
    "thumbnail_url",
    "item_web_url",
    "condition",
    "source_query",
    "match_confidence",
    "auction_id",
    "lot_number",
    "cannons_title",
    "cannons_description",
    "current_bid",
    "total_bids",
    "detail_url",
    "raw_match_json",
)

# PostgREST accepts large arrays, but keep batches bounded so a big backfill
# doesn't build one giant request body.
DEFAULT_BATCH_SIZE = 500

# Retry transient failures (network errors, rate limits, 5xx) with exponential
# backoff (2s, 4s, 8s, 16s) — the same convention as supabase_enrichment.py.
# Supabase occasionally returns a brief 503 (PGRST002 "Could not query the
# database for the schema cache") while PostgREST reconnects; without retries
# one such blip fails the whole hourly scrape job.
DEFAULT_MAX_RETRIES = 4

# Per-request timeouts as (connect, read) tuples. Connect stays short so a dead
# host fails fast; the read ceiling is generous because the comp_item_freshness
# view is a growing server-side aggregation that has begun taking >30s — a flat
# 30s read timeout was firing on every retry and failing the whole hourly scrape
# (ReadTimeout, not a transient the retry loop could absorb). Override the read
# ceiling via GOONERS_SUPABASE_READ_TIMEOUT.
_READ_TIMEOUT_SECONDS = _SupaCfg().read_timeout
READ_TIMEOUT = (10, _READ_TIMEOUT_SECONDS)
WRITE_TIMEOUT = (10, 60)


def _is_transient(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _request_with_retry(send, describe: str, max_retries: int = DEFAULT_MAX_RETRIES):
    """Call ``send()`` (a zero-arg request) and return the response, retrying
    transient failures; raise RuntimeError on permanent failure."""
    import requests

    for attempt in range(max_retries + 1):
        try:
            response = send()
        except requests.exceptions.RequestException as exc:
            if attempt >= max_retries:
                raise RuntimeError(
                    f"{describe} failed after {attempt + 1} attempt(s): {exc}"
                ) from exc
            time.sleep(2 ** (attempt + 1))
            continue
        if response.status_code < 400:
            return response
        if _is_transient(response.status_code) and attempt < max_retries:
            time.sleep(2 ** (attempt + 1))
            continue
        raise RuntimeError(
            f"{describe} failed ({response.status_code}): {response.text[:300]}"
        )


def json_safe(value):
    """Coerce a row value into something ``json.dumps`` can emit for PostgREST."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC).isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def row_payload(row: dict) -> dict:
    """Project a comp row dict onto the table columns, JSON-safe."""
    return {column: json_safe(row.get(column)) for column in COMP_COLUMNS}


def resolve_credentials(
    url: str | None = None, key: str | None = None
) -> tuple[str | None, str | None]:
    """Resolve (project URL, secret key) from args or env.

    Reads ``SUPABASE_URL`` (falling back to ``VITE_SUPABASE_URL``, which the
    deploy/build env already sets) and the backend-only ``SUPABASE_SECRET_KEY``.
    """
    url = url or secrets.supabase_url()
    key = key or secrets.supabase_secret_key()
    return url, key


def append_ebay_comp_snapshots(
    rows: list[dict],
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Append comp snapshot rows to Supabase. Returns rows written."""
    if not rows:
        return 0

    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write comps to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write comps to Supabase")

    from http_client import supabase_session

    session = session or supabase_session("comps")
    endpoint = f"{url.rstrip('/')}/rest/v1/{COMP_SNAPSHOT_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = [row_payload(row) for row in rows[start : start + batch_size]]
        _request_with_retry(
            partial(
                session.post,
                endpoint,
                headers=headers,
                data=json.dumps(batch),
                timeout=WRITE_TIMEOUT,
            ),
            "Supabase comp insert",
        )
        written += len(batch)
    return written


def content_range_total(value: str | None) -> int:
    """Parse the row total out of a PostgREST ``Content-Range`` header.

    Header looks like ``0-0/1234`` (or ``*/*`` when unknown); returns the count
    after the slash, 0 when absent/unknown.
    """
    if not value or "/" not in value:
        return 0
    total = value.rsplit("/", 1)[1]
    try:
        return int(total)
    except ValueError:
        return 0


class SupabaseCompLedger(CompLedger):
    """Reads the scraper's freshness + request-budget ledger from Supabase.

    Replaces the per-auction JSON files as the scraper's state store (issue #6
    phase 2): freshness comes from the ``comp_item_freshness`` view, the request
    budget from counting ``comp_query_attempts`` rows. Reads use the secret key
    (service_role, bypasses RLS), the same credentials the writer uses.
    """

    def __init__(
        self, url: str | None = None, key: str | None = None, session=None
    ) -> None:
        url, key = resolve_credentials(url, key)
        if not url:
            raise RuntimeError("SUPABASE_URL is required to read the comp ledger")
        if not key:
            raise RuntimeError(
                "SUPABASE_SECRET_KEY is required to read the comp ledger"
            )
        self.url = url.rstrip("/")
        self.key = key
        self._session = session

    def _session_obj(self):
        if self._session is None:
            from http_client import supabase_session

            self._session = supabase_session("comps")
        return self._session

    def _headers(self, count: bool = False) -> dict:
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        if count:
            # Ask PostgREST for the exact total in the Content-Range header so a
            # count needs no full row download.
            headers["Prefer"] = "count=exact"
        return headers

    def _endpoint(self, view: str) -> str:
        return f"{self.url}/rest/v1/{view}"

    def _get_all(self, view: str, params: dict) -> list[dict]:
        rows: list[dict] = []
        offset = 0
        session = self._session_obj()
        while True:
            page = {**params, "limit": str(READ_PAGE_SIZE), "offset": str(offset)}
            response = _request_with_retry(
                partial(
                    session.get,
                    self._endpoint(view),
                    headers=self._headers(),
                    params=page,
                    timeout=READ_TIMEOUT,
                ),
                "Supabase ledger read",
            )
            batch = response.json() or []
            rows.extend(batch)
            if len(batch) < READ_PAGE_SIZE:
                return rows
            offset += READ_PAGE_SIZE

    def fresh_keys(
        self, stale_hours: int, skip_attempted: bool = False, now=None
    ) -> set[str]:
        """``{auction_safe_id:item_id}`` for items fetched within the window.

        Mirrors :func:`ebay_comps.fresh_comp_keys_from_files`: ``skip_attempted``
        counts any recorded attempt however old; otherwise items fetched within
        ``stale_hours`` count, and ``stale_hours <= 0`` skips nothing.
        """
        if not skip_attempted and stale_hours <= 0:
            return set()
        params = {"select": "auction_safe_id,item_id"}
        if not skip_attempted:
            now = now or datetime.now(UTC)
            cutoff = now.astimezone(UTC) - timedelta(hours=stale_hours)
            params["last_fetched_at"] = f"gte.{cutoff.isoformat()}"
        keys = set()
        for row in self._get_all(FRESHNESS_VIEW, params):
            safe_id = row.get("auction_safe_id")
            item_id = row.get("item_id")
            if safe_id is not None and item_id is not None:
                keys.add(f"{safe_id}:{item_id}")
        return keys

    def _count_since(self, start: datetime) -> int:
        params = {
            "select": "fetched_at",
            "fetched_at": f"gte.{start.astimezone(UTC).isoformat()}",
            "limit": "1",
        }
        response = _request_with_retry(
            partial(
                self._session_obj().get,
                self._endpoint(QUERY_ATTEMPTS_VIEW),
                headers=self._headers(count=True),
                params=params,
                timeout=READ_TIMEOUT,
            ),
            "Supabase ledger count",
        )
        return content_range_total(response.headers.get("Content-Range"))

    def requests_used_in_month(self, now=None) -> int:
        now = (now or datetime.now(UTC)).astimezone(UTC)
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return self._count_since(start)

    def requests_used_today(self, now=None) -> int:
        now = (now or datetime.now(UTC)).astimezone(UTC)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return self._count_since(start)

    # ── Provider quota meter (issue #299) ────────────────────────────────────

    def _usage_remaining(self, params: dict) -> int | None:
        """Read one ``remaining`` value from ``soldcomps_usage`` for ``params``."""
        response = _request_with_retry(
            partial(
                self._session_obj().get,
                self._endpoint(USAGE_TABLE),
                headers=self._headers(),
                params={"select": "remaining", "limit": "1", **params},
                timeout=READ_TIMEOUT,
            ),
            "Supabase provider-quota read",
        )
        rows = response.json() or []
        if not rows:
            return None
        try:
            return int(rows[0]["remaining"])
        except (KeyError, TypeError, ValueError):
            return None

    def provider_remaining(self, now=None) -> int | None:
        """Most recent provider-reported remaining quota in the current billing period.

        Scoped to readings from this calendar month so a previous period's
        exhausted-quota reading (remaining=0) doesn't block the new period's
        first run. Returns None when no reading exists yet this period, letting
        the budget gate fall back to the coarse attempt count.
        """
        now = (now or datetime.now(UTC)).astimezone(UTC)
        period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return self._usage_remaining(
            {
                "observed_at": f"gte.{period_start.isoformat()}",
                "order": "observed_at.desc",
            }
        )

    def provider_used_today(self, now=None) -> int:
        """Billed requests spent today per the provider meter.

        Remaining decreases monotonically within a period, so today's spend is
        the day's high reading minus the latest one. 0 when nothing was observed
        today (no basis to constrain pacing) or remaining unknown.
        """
        latest = self.provider_remaining(now)
        if latest is None:
            return 0
        now = (now or datetime.now(UTC)).astimezone(UTC)
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        high = self._usage_remaining(
            {"observed_at": f"gte.{start.isoformat()}", "order": "remaining.desc"}
        )
        if high is None:
            return 0
        return max(0, high - latest)

    def record_provider_remaining(self, remaining, raw=None, now=None) -> None:
        """Append an observed provider remaining-quota reading."""
        payload: dict = {"remaining": int(remaining)}
        if now is not None:
            payload["observed_at"] = now.astimezone(UTC).isoformat()
        if raw is not None:
            payload["raw"] = raw
        _request_with_retry(
            partial(
                self._session_obj().post,
                self._endpoint(USAGE_TABLE),
                headers={
                    **self._headers(),
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                data=json.dumps(payload),
                timeout=WRITE_TIMEOUT,
            ),
            "Supabase provider-quota write",
        )
