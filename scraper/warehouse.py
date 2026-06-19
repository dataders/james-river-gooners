"""Warehouse access seam for the scraper.

The warehouse is the optional system-of-record / analytics store behind the
static read model. It is reached only through this module: the rest of the
scraper talks to a :class:`SnapshotSink`, never to ``duckdb`` directly. Swapping
MotherDuck for Supabase is therefore implementing one new ``SnapshotSink``
subclass and selecting it via ``GOONERS_WAREHOUSE`` — no call sites change.

See ``docs/data-architecture.md`` for the full picture.

Note: :func:`connect` returns a raw DuckDB/MotherDuck connection and is
DuckDB-specific. The portable contract is the :class:`SnapshotSink` append
methods; portable code should depend on those, not on :func:`connect`.
"""

import os
import secrets
from abc import ABC, abstractmethod

DEFAULT_DATABASE = "md:"


def resolve_database(database: str | None = None) -> str:
    """Return the database string, defaulting to env / MotherDuck."""
    return database or os.environ.get("MOTHERDUCK_DATABASE", DEFAULT_DATABASE)


def is_motherduck(database: str) -> bool:
    return database.startswith("md:")


def require_motherduck_token(database: str, action: str = "use MotherDuck") -> None:
    """Raise if a MotherDuck database is targeted without a token configured."""
    if is_motherduck(database) and not secrets.motherduck_token():
        raise RuntimeError(f"MOTHERDUCK_TOKEN is required to {action}")


def connect(database: str | None = None, action: str = "use MotherDuck"):
    """Open a DuckDB/MotherDuck connection, enforcing the token guard."""
    database = resolve_database(database)
    require_motherduck_token(database, action)
    import duckdb

    return duckdb.connect(database)


# Process-lived connection cache. Opening a MotherDuck (cloud) connection pays an
# auth + round-trip handshake worth several seconds; the per-auction snapshot
# append used to pay it on every call (22 auctions → 22 handshakes per scrape).
# Reuse one connection per database for the life of the process instead.
_CACHED_CONNECTIONS: dict = {}


def cached_connect(database: str | None = None, action: str = "use MotherDuck"):
    """Return a process-cached connection for ``database``, opening it once.

    Callers must NOT close it — it lives until the process exits (or is dropped
    via :func:`reset_cached_connection` after an error)."""
    database = resolve_database(database)
    conn = _CACHED_CONNECTIONS.get(database)
    if conn is None:
        conn = connect(database, action)
        _CACHED_CONNECTIONS[database] = conn
    return conn


def reset_cached_connection(database: str | None = None) -> None:
    """Drop (and close) a cached connection so the next call reconnects — used to
    recover from a connection that went stale mid-scrape."""
    database = resolve_database(database)
    conn = _CACHED_CONNECTIONS.pop(database, None)
    if conn is not None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass


def warehouse_kind() -> str:
    """Which warehouse implementation to use (``GOONERS_WAREHOUSE``)."""
    return os.environ.get("GOONERS_WAREHOUSE", "motherduck").strip().lower()


class SnapshotSink(ABC):
    """Portable contract for appending snapshots to the warehouse."""

    @abstractmethod
    def append_listing_snapshots(self, items: list[dict], source_url: str) -> int:
        """Append one listing snapshot per item. Returns rows written."""

    @abstractmethod
    def append_comp_snapshots(self, rows: list[dict]) -> int:
        """Append eBay comp snapshot rows. Returns rows written."""


class MotherDuckSink(SnapshotSink):
    def __init__(self, database: str | None = None) -> None:
        self.database = database

    def append_listing_snapshots(self, items: list[dict], source_url: str) -> int:
        from motherduck import append_listing_snapshots

        return append_listing_snapshots(items, source_url, database=self.database)

    def append_comp_snapshots(self, rows: list[dict]) -> int:
        from ebay_comps import append_ebay_comp_snapshots

        return append_ebay_comp_snapshots(rows, database=self.database)


class SupabaseSink(SnapshotSink):
    """PostgREST sink — eBay comps only so far (issue #6).

    Listing snapshots stay in MotherDuck until the #98 migration, so the
    listing method raises rather than silently dropping rows.
    """

    def append_listing_snapshots(self, items: list[dict], source_url: str) -> int:
        raise NotImplementedError(
            "Listing snapshots to Supabase are part of the #98 migration; "
            "only eBay comps (#6) are wired up so far."
        )

    def append_comp_snapshots(self, rows: list[dict]) -> int:
        from supabase_comps import append_ebay_comp_snapshots

        return append_ebay_comp_snapshots(rows)


def get_sink(database: str | None = None) -> SnapshotSink | None:
    """Return the configured sink, or ``None`` when the warehouse is disabled."""
    kind = warehouse_kind()
    if kind in ("", "none", "off", "disabled"):
        return None
    if kind == "motherduck":
        return MotherDuckSink(database)
    if kind == "supabase":
        return SupabaseSink()
    raise ValueError(f"Unknown GOONERS_WAREHOUSE={kind!r}")


def should_mirror() -> bool:
    """Whether the configured warehouse is ready to receive a snapshot mirror.

    The mirror is best-effort and only runs when its backend is actually
    configured: MotherDuck gated on ``GOONERS_MOTHERDUCK_SNAPSHOTS`` (+ token),
    Supabase gated on its URL + secret key being present.
    """
    kind = warehouse_kind()
    if kind in ("", "none", "off", "disabled"):
        return False
    if kind == "motherduck":
        from motherduck import should_snapshot_to_motherduck

        return should_snapshot_to_motherduck()
    if kind == "supabase":
        from supabase_comps import resolve_credentials

        url, key = resolve_credentials()
        return bool(url and key)
    return False
