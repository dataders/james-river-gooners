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

    # ── Provider quota meter (issue #299) ────────────────────────────────────
    # The coarse counts above tally every *attempt* (including the ~90%
    # no_results rows and free HTML-fallbacks that never hit the paid meter), so
    # they overcount real billed calls. When the SoldComps provider reports its
    # own remaining quota (the X-Usage-* header), that is the authoritative meter
    # the start gate should prefer. Backends without a provider meter (the file
    # ledger) inherit these no-op defaults and fall back to the coarse counts.

    def provider_remaining(self, now: datetime | None = None) -> int | None:
        """Most recent provider-reported remaining quota, or None if unknown."""
        return None

    def provider_used_today(self, now: datetime | None = None) -> int:
        """Billed requests spent today per the provider meter (high − latest)."""
        return 0

    def record_provider_remaining(
        self, remaining: int, raw: dict | None = None, now: datetime | None = None
    ) -> None:
        """Persist an observed provider remaining-quota reading. No-op by default."""
        return None


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
    provider_min_remaining: int = 0,
) -> tuple[bool, int]:
    """Return ``(cap_active, query_limit)`` for this run.

    Combines the monthly ceiling, optional daily pacing, and an explicit per-run
    ``--max-queries`` cap. ``cap_active`` is False only when nothing constrains
    the run.

    When the provider's reported remaining quota is known (issue #299), the
    monthly ceiling gates on *that* authoritative meter (``ledger.provider_remaining``)
    rather than the coarse ``comp_query_attempts`` count, which overcounts (it
    tallies no_results + free HTML-fallback attempts that never hit the paid
    ``/v1/scrape`` meter). ``--monthly-budget`` then acts only as a secondary
    coarse per-run cap; the provider header is the real floor
    (``provider_min_remaining``). The coarse count is used only as a fallback
    when no provider reading is available.
    """
    now = now or datetime.now(timezone.utc)
    provider_remaining = ledger.provider_remaining(now)
    cap_active = False
    query_limit = 0
    provider_based = False
    if monthly_budget > 0:
        cap_active = True
        if provider_remaining is not None:
            # Authoritative meter: how many billed requests remain this period,
            # never more than the configured budget (the secondary coarse cap).
            query_limit = min(
                monthly_budget, max(0, provider_remaining - provider_min_remaining)
            )
            provider_based = True
        else:
            query_limit = max(0, monthly_budget - ledger.requests_used_in_month(now))
        if daily_pacing and query_limit > 0:
            days_left = max(1, calendar.monthrange(now.year, now.month)[1] - now.day + 1)
            daily_allowance = -(-query_limit // days_left)  # ceil division
            used_today = (
                ledger.provider_used_today(now)
                if provider_based
                else ledger.requests_used_today(now)
            )
            remaining_today = max(0, daily_allowance - used_today)
            query_limit = min(query_limit, remaining_today)
    if max_queries > 0:
        query_limit = min(query_limit, max_queries) if cap_active else max_queries
        cap_active = True
    return cap_active, query_limit
