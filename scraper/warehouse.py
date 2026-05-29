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
from abc import ABC, abstractmethod


DEFAULT_DATABASE = "md:"


def resolve_database(database: str | None = None) -> str:
    """Return the database string, defaulting to env / MotherDuck."""
    return database or os.environ.get("MOTHERDUCK_DATABASE", DEFAULT_DATABASE)


def is_motherduck(database: str) -> bool:
    return database.startswith("md:")


def require_motherduck_token(database: str, action: str = "use MotherDuck") -> None:
    """Raise if a MotherDuck database is targeted without a token configured."""
    if is_motherduck(database) and not os.environ.get("MOTHERDUCK_TOKEN"):
        raise RuntimeError(f"MOTHERDUCK_TOKEN is required to {action}")


def connect(database: str | None = None, action: str = "use MotherDuck"):
    """Open a DuckDB/MotherDuck connection, enforcing the token guard."""
    database = resolve_database(database)
    require_motherduck_token(database, action)
    import duckdb

    return duckdb.connect(database)


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


def get_sink(database: str | None = None) -> SnapshotSink | None:
    """Return the configured sink, or ``None`` when the warehouse is disabled."""
    kind = warehouse_kind()
    if kind in ("", "none", "off", "disabled"):
        return None
    if kind == "motherduck":
        return MotherDuckSink(database)
    if kind == "supabase":
        raise NotImplementedError(
            "SupabaseSink is not implemented yet; see docs/data-architecture.md"
        )
    raise ValueError(f"Unknown GOONERS_WAREHOUSE={kind!r}")
