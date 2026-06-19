"""Corpus-first reuse: skip the paid SoldComps API when the corpus covers a lot.

SoldComps Phase 2 / RFC #290, increment 3. Before spending a ``/v1/scrape``
request on a lot, ask the sold-listings corpus (via the per-item KNN RPC
``match_sold_listings_for_item``, 0027) whether it already holds enough fresh,
visually-similar sold listings. If so, build the comps from the corpus and skip
the API; otherwise fall through to the paid fetch (which then *feeds* the corpus
for next time). Spend amortises: you pay to build the corpus early, then reuse it.

**Opt-in** via ``GOONERS_CORPUS_FIRST=1`` and only meaningful with Supabase + the
embeddings populated — a true no-op otherwise, so the comp fetch is unchanged by
default. Thresholds (RFC D3, env-tunable): ``MIN_FRESH=3``, ``MAX_AGE_DAYS=60``,
``MIN_SIM=0.85``.
"""

import json
import os
from datetime import UTC, date, datetime
from functools import partial

from supabase_comps import WRITE_TIMEOUT, _request_with_retry, resolve_credentials

RPC = "match_sold_listings_for_item"
# Supabase rejects the secret key from a browser-looking UA; any non-browser UA
# works. Defined locally (not imported from embed_nomic) so corpus-first reuse
# stays in the lightweight comp-fetch env — no numpy / embedding stack needed.
_SUPABASE_UA = "gooners-corpus-reuse/1.0 (+scraper)"

# RFC #290 D3 thresholds — internal quality parameters, not CI operator knobs.
# Tune these in code (with tests), not at runtime via env vars.
_MIN_FRESH = 3
_MAX_AGE_DAYS = 60
_MIN_SIM = 0.85
_HIGH_SIM = 0.85
_MATCH_COUNT = 5
_KEEP = 3


def corpus_first_enabled() -> bool:
    """Whether to try corpus-first reuse before spending the API (opt-in)."""
    return os.environ.get("GOONERS_CORPUS_FIRST", "").lower() in {"1", "true", "yes", "on"}


def _parse_date(value) -> date | None:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def fresh_matches(
    matches: list[dict], max_age_days: int = _MAX_AGE_DAYS, now=None
) -> list[dict]:
    """Matches whose sale is within ``max_age_days`` (a sale with no date is not
    counted as fresh — conservative, so a stale comp never anchors a live lot)."""
    today = (now or datetime.now(UTC)).date()
    fresh = []
    for match in matches or []:
        sold = _parse_date(match.get("sold_date"))
        if sold is not None and (today - sold).days <= max_age_days:
            fresh.append(match)
    return fresh


def has_fresh_coverage(
    matches: list[dict],
    *,
    min_fresh: int = _MIN_FRESH,
    max_age_days: int = _MAX_AGE_DAYS,
    now=None,
) -> bool:
    """True when the corpus covers a lot well enough to skip the paid API."""
    return len(fresh_matches(matches, max_age_days, now)) >= min_fresh


def reuse_comp_rows(
    matches: list[dict], safe_id: str, item_id: str, fetched_at: str
) -> list[dict]:
    """Shape per-item corpus matches into ebay_comp_snapshots rows.

    Tagged ``source_query='visual'`` (same as the batch re-rank), so reused comps
    slot into ``public_auction_comps`` indistinguishably from freshly-fetched ones.
    """
    rows = []
    for match in matches[:_KEEP]:
        if not match.get("item_web_url"):
            continue
        sim = match.get("similarity") or 0
        rows.append(
            {
                "auction_safe_id": safe_id,
                "item_id": str(item_id),
                "status": "ok",
                "query": "",
                "fetched_at": fetched_at,
                "ebay_item_id": match.get("ebay_item_id"),
                "title": match.get("title"),
                "price_value": match.get("sold_price"),
                "price_currency": "USD",
                "sold_date": match.get("sold_date"),
                "sold_date_label": match.get("sold_date_label"),
                "thumbnail_url": match.get("thumbnail_url"),
                "item_web_url": match.get("item_web_url"),
                "condition": match.get("condition"),
                "source_query": "visual",
                "match_confidence": "high" if sim >= _HIGH_SIM else "medium",
            }
        )
    return rows


def fetch_item_coverage(
    safe_id: str,
    item_id: str,
    url: str,
    key: str,
    session,
    match_count: int = _MATCH_COUNT,
    min_sim: float = _MIN_SIM,
) -> list[dict]:
    """Call the per-item KNN RPC; return corpus listings >= min_sim for the lot."""
    endpoint = f"{url.rstrip('/')}/rest/v1/rpc/{RPC}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": _SUPABASE_UA,
    }
    resp = _request_with_retry(
        partial(
            session.post,
            endpoint,
            headers=headers,
            data=json.dumps(
                {
                    "p_auction_safe_id": safe_id,
                    "p_item_id": str(item_id),
                    "match_count": match_count,
                    "min_sim": min_sim,
                }
            ),
            timeout=WRITE_TIMEOUT,
        ),
        f"{RPC}({safe_id}:{item_id})",
    )
    return resp.json() or []


class CorpusReuser:
    """Stateful corpus-first reuse helper for one comp-fetch run.

    Resolves credentials once; ``covered_comps(item)`` returns the reuse comp rows
    when the corpus covers the lot freshly enough, or ``None`` to spend the API.
    A no-op (always ``None``) when disabled or Supabase is unconfigured.
    """

    def __init__(self, fetched_at: str, session=None, enabled: bool | None = None):
        self.fetched_at = fetched_at
        self.enabled = corpus_first_enabled() if enabled is None else enabled
        url, key = resolve_credentials()
        self.url: str = url or ""
        self.key: str = key or ""
        if not self.url or not self.key:
            self.enabled = False
        self._session = session

    def _session_obj(self):
        if self._session is None:
            import requests

            self._session = requests.Session()
        return self._session

    def covered_comps(self, item: dict) -> list[dict] | None:
        if not self.enabled:
            return None
        safe_id = item.get("auctionSafeId")
        item_id = item.get("id")
        if not safe_id or item_id is None:
            return None
        safe_id, item_id = str(safe_id), str(item_id)
        try:
            matches = fetch_item_coverage(
                safe_id, item_id, self.url, self.key, self._session_obj()
            )
        except RuntimeError:
            return (
                None  # coverage check must never break the fetch — just spend the API
            )
        if not has_fresh_coverage(matches):
            return None
        return reuse_comp_rows(matches, safe_id, item_id, self.fetched_at)
