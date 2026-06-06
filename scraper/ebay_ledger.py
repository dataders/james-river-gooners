"""eBay comp freshness + request-budget ledger.

The ``CompLedger`` ABC and its two implementations: ``FileCompLedger`` (legacy
JSON-backed) and ``SupabaseCompLedger`` (imported from ``supabase_comps``).
Also owns the budget-resolution logic used by the main fetch loop.
"""

import calendar
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from ebay_export import fresh_comp_keys_from_files, requests_used_in_month, requests_used_today


class CompLedger(ABC):
    """Freshness + request-budget state store for a comp run.

    The file backend reads from the JSON read model; the Supabase backend reads
    from reconstruction views (``comp_item_freshness`` / ``comp_query_attempts``).
    """

    @abstractmethod
    def fresh_keys(self, stale_hours: int, skip_attempted: bool = False) -> set[str]:
        """``{auction_safe_id:item_id}`` for items fetched within the window."""

    @abstractmethod
    def requests_used_in_month(self, now: datetime | None = None) -> int:
        """eBay requests spent in the current month."""

    @abstractmethod
    def requests_used_today(self, now: datetime | None = None) -> int:
        """eBay requests spent so far today."""


class FileCompLedger(CompLedger):
    """Ledger backed by the static per-auction JSON read model (legacy/offline)."""

    def __init__(self, output_dir) -> None:
        self.output_dir = output_dir

    def fresh_keys(self, stale_hours: int, skip_attempted: bool = False) -> set[str]:
        return fresh_comp_keys_from_files(self.output_dir, stale_hours, skip_attempted)

    def requests_used_in_month(self, now: datetime | None = None) -> int:
        return requests_used_in_month(self.output_dir, now)

    def requests_used_today(self, now: datetime | None = None) -> int:
        return requests_used_today(self.output_dir, now)


def supabase_comp_backend_active() -> bool:
    """Whether comps should use Supabase as the read model + ledger this run."""
    from warehouse import warehouse_kind

    if warehouse_kind() != "supabase":
        return False
    from supabase_comps import resolve_credentials

    url, key = resolve_credentials()
    return bool(url and key)


def resolve_query_budget(
    ledger: CompLedger,
    monthly_budget: int,
    max_queries: int,
    daily_pacing: bool,
    now: datetime | None = None,
) -> tuple[bool, int]:
    """Return ``(cap_active, query_limit)`` for this run.

    Combines the shared monthly ceiling (from the ledger), optional daily
    pacing, and an explicit per-run ``--max-queries`` cap.
    ``cap_active`` is False only when nothing constrains the run.
    """
    now = now or datetime.now(timezone.utc)
    cap_active = False
    query_limit = 0
    if monthly_budget > 0:
        cap_active = True
        query_limit = max(0, monthly_budget - ledger.requests_used_in_month(now))
        if daily_pacing and query_limit > 0:
            days_left = max(1, calendar.monthrange(now.year, now.month)[1] - now.day + 1)
            daily_allowance = -(-query_limit // days_left)  # ceil division
            remaining_today = max(0, daily_allowance - ledger.requests_used_today(now))
            query_limit = min(query_limit, remaining_today)
    if max_queries > 0:
        query_limit = min(query_limit, max_queries) if cap_active else max_queries
        cap_active = True
    return cap_active, query_limit
