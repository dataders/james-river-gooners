"""Parse Supabase's privileged Prometheus metrics into loadable rows.

The privileged metrics endpoint (`/customer/v1/privileged/metrics`) returns a
Prometheus text-exposition snapshot of the project's infrastructure: host load
(node_exporter), database internals (postgres_exporter) and the Supabase service
layer (auth / storage / realtime / pooler). Each scrape is a point-in-time
sample, so we load one row per series per run (append/merge by snapshot time)
and let the views / dbt models turn the raw counters and gauges into the
reliability / load / performance answers.

Everything here is pure (no network, no dlt), so it's hermetically testable:

- ``parse_type_lines`` reads the ``# TYPE`` comments so each sample carries its
  Prometheus type (counter vs gauge) — the dbt rate models need this to know
  which series to diff.
- ``parse_metric_line`` turns one exposition line into ``(name, labels, value)``,
  handling quoted/escaped label values and ``NaN``/``Inf``.
- ``classify`` tags each metric with a ``subsystem`` (host / database / …) and a
  reliability/load/performance ``pillar`` via longest-prefix match.
- ``metric_rows`` ties it together into the row dicts the pipeline yields.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Iterable, Iterator
from datetime import datetime

# --- Curation -------------------------------------------------------------
#
# (prefix, subsystem, pillar) — longest matching prefix wins. We tag the
# well-documented node_exporter + postgres_exporter families (stable names) as
# the curated core; everything else is still captured when ``--all`` is set but
# tagged subsystem='other'/pillar=None so the table stays queryable without
# over-fitting to service-metric names that drift between Supabase releases.
#
# Pillars:
#   load        — utilisation / throughput (how hard the box is working)
#   performance — latency / efficiency (how well it's serving that work)
#   reliability — errors / availability (when it's failing)
#
# Names below are the real series the Supabase privileged endpoint exposes
# (verified against a live project). Counters carry a ``_total`` suffix; prefixes
# match those (and any sub-breakdowns, e.g. the ``conflicts_confl_*`` family)
# without hard-coding the suffix, so they survive Supabase exporter changes.
CURATED: tuple[tuple[str, str, str | None], ...] = (
    # ---- Host (node_exporter) ----
    ("node_load1", "host", "load"),
    ("node_load5", "host", "load"),
    ("node_load15", "host", "load"),
    ("node_cpu_seconds_total", "host", "load"),
    ("node_memory_MemTotal_bytes", "host", "load"),
    ("node_memory_MemAvailable_bytes", "host", "load"),
    ("node_memory_MemFree_bytes", "host", "load"),
    ("node_filesystem_avail_bytes", "host", "load"),
    ("node_filesystem_size_bytes", "host", "load"),
    ("node_filefd_allocated", "host", "load"),
    ("node_filefd_maximum", "host", "load"),
    ("node_network_receive_bytes_total", "host", "load"),
    ("node_network_transmit_bytes_total", "host", "load"),
    ("node_disk_read_bytes_total", "host", "load"),
    ("node_disk_written_bytes_total", "host", "load"),
    ("node_disk_io_time_seconds_total", "host", "performance"),
    ("node_boot_time_seconds", "host", "reliability"),
    ("node_vmstat_oom_kill", "host", "reliability"),
    # ---- Database (postgres_exporter) ----
    ("pg_up", "database", "reliability"),
    ("pg_stat_database_blks_hit", "database", "performance"),
    ("pg_stat_database_blks_read", "database", "performance"),
    ("pg_stat_database_xact_commit", "database", "load"),
    ("pg_stat_database_xact_rollback", "database", "reliability"),
    ("pg_stat_database_deadlocks", "database", "reliability"),
    ("pg_stat_database_conflicts", "database", "reliability"),
    ("pg_stat_database_num_backends", "database", "load"),
    ("pg_stat_database_tup_returned", "database", "load"),
    ("pg_stat_database_tup_fetched", "database", "performance"),
    ("pg_stat_database_temp_bytes", "database", "performance"),
    ("pg_stat_bgwriter_checkpoints_timed", "database", "performance"),
    ("pg_stat_bgwriter_checkpoints_req", "database", "performance"),
    ("pg_database_size_bytes", "database", "load"),
    ("supabase_usage_metrics_user_queries", "database", "load"),
    # Connections (Supabase-custom gauges) + replication.
    ("connection_stats_connection_count", "database", "load"),
    ("direct_connection_stats_connection_count", "database", "load"),
    ("max_connections_connection_count", "database", "load"),
    ("physical_replication_lag_physical_replication_lag_seconds", "database", "performance"),
    ("physical_replication_lag_is_connected_to_primary", "database", "reliability"),
    # ---- PostgREST (the data API the browser hits) ----
    ("pgrst_db_pool_available", "postgrest", "load"),
    ("pgrst_db_pool_max", "postgrest", "load"),
    ("pgrst_db_pool_waiting", "postgrest", "reliability"),
    ("pgrst_db_pool_timeouts", "postgrest", "reliability"),
    ("pgrst_schema_cache_query_time_seconds", "postgrest", "performance"),
    # ---- Pooler (pgbouncer) ----
    ("pgbouncer_up", "pooler", "reliability"),
    ("pgbouncer_pools_client_waiting_connections", "pooler", "reliability"),
    ("pgbouncer_pools_server_active_connections", "pooler", "load"),
    ("pgbouncer_pools_client_active_connections", "pooler", "load"),
    ("pgbouncer_stats_queries_pooled", "pooler", "load"),
    ("pgbouncer_stats_queries_duration_seconds", "pooler", "performance"),
    # ---- Service layer ----
    ("realtime_postgres_changes_total_subscriptions", "realtime", "load"),
    ("gotrue", "auth", "reliability"),
    ("storage", "storage", "load"),
)


def classify(metric: str) -> tuple[str, str | None, bool]:
    """Return ``(subsystem, pillar, is_curated)`` for a metric name."""
    best: tuple[str, str | None] | None = None
    best_len = -1
    for prefix, subsystem, pillar in CURATED:
        if metric.startswith(prefix) and len(prefix) > best_len:
            best = (subsystem, pillar)
            best_len = len(prefix)
    if best is None:
        return "other", None, False
    return best[0], best[1], True


# --- Prometheus text parsing ---------------------------------------------

_TYPE_SUFFIXES = ("_bucket", "_sum", "_count")


def parse_type_lines(text: str) -> dict[str, str]:
    """Map metric family name → Prometheus type from ``# TYPE`` comments."""
    types: dict[str, str] = {}
    for line in text.splitlines():
        if line.startswith("# TYPE "):
            parts = line.split()
            # "# TYPE <name> <type>"
            if len(parts) >= 4:
                types[parts[2]] = parts[3]
    return types


def metric_type_for(name: str, types: dict[str, str]) -> str:
    """Look up a series' type, accounting for histogram/summary suffixes."""
    if name in types:
        return types[name]
    for suffix in _TYPE_SUFFIXES:
        if name.endswith(suffix) and name[: -len(suffix)] in types:
            # _sum/_count on a histogram/summary accumulate → treat as counter.
            return "counter"
    return "untyped"


def _parse_value(raw: str) -> float | None:
    """Float-parse a Prometheus sample value; drop NaN/Inf (not storable)."""
    try:
        val = float(raw)
    except ValueError:
        return None
    if math.isnan(val) or math.isinf(val):
        return None
    return val


def _parse_labels(text: str, start: int) -> tuple[str, dict[str, str]]:
    """Parse a ``{a="x",b="y"}`` block beginning at ``text[start] == '{'``.

    Returns ``(remainder_after_close_brace, labels)``. Handles the backslash
    escapes Prometheus allows inside quoted label values (``\\"``, ``\\\\``,
    ``\\n``)."""
    labels: dict[str, str] = {}
    i = start + 1
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "}":
            return text[i + 1 :], labels
        if ch in " ,":
            i += 1
            continue
        # key
        j = i
        while j < n and (text[j].isalnum() or text[j] == "_"):
            j += 1
        key = text[i:j]
        while j < n and text[j] == " ":
            j += 1
        if j >= n or text[j] != "=":
            break
        j += 1
        while j < n and text[j] == " ":
            j += 1
        if j >= n or text[j] != '"':
            break
        j += 1
        buf: list[str] = []
        while j < n:
            c = text[j]
            if c == "\\" and j + 1 < n:
                nxt = text[j + 1]
                buf.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
                j += 2
                continue
            if c == '"':
                j += 1
                break
            buf.append(c)
            j += 1
        labels[key] = "".join(buf)
        i = j
    return text[i:], labels


def parse_metric_line(line: str) -> tuple[str, dict[str, str], float] | None:
    """Parse one exposition line into ``(name, labels, value)`` or ``None``.

    ``None`` for blanks, ``#`` comments, and unparseable/non-finite samples."""
    line = line.strip()
    if not line or line[0] == "#":
        return None
    brace = line.find("{")
    space = line.find(" ")
    if brace != -1 and (space == -1 or brace < space):
        name = line[:brace]
        rest, labels = _parse_labels(line, brace)
        value_part = rest.strip()
    elif space != -1:
        name = line[:space]
        labels = {}
        value_part = line[space + 1 :].strip()
    else:
        return None
    if not name or not value_part:
        return None
    # value_part is "<value>" or "<value> <timestamp>" — we use our own scrape
    # time, so the optional exposition timestamp is ignored.
    value = _parse_value(value_part.split()[0])
    if value is None:
        return None
    return name, labels, value


def _label_hash(labels: dict[str, str]) -> str:
    """Stable short hash of a label set — the per-series identity in the table."""
    canonical = json.dumps(labels, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]


def metric_rows(
    text: str,
    scraped_at: datetime,
    *,
    curated_only: bool = True,
) -> Iterator[dict]:
    """Yield one loadable row per metric series in a Prometheus snapshot.

    Each row is a point-in-time sample stamped with ``scraped_at`` (the scrape
    time, shared by every row in the run). Label sets are stored as a sorted
    JSON string (``labels_json``) plus a ``label_hash`` so the row stays flat
    (no dlt child tables) while series remain individually addressable.
    """
    types = parse_type_lines(text)
    for line in text.splitlines():
        parsed = parse_metric_line(line)
        if parsed is None:
            continue
        name, labels, value = parsed
        subsystem, pillar, is_curated = classify(name)
        if curated_only and not is_curated:
            continue
        yield {
            "scraped_at": scraped_at,
            "metric": name,
            "metric_type": metric_type_for(name, types),
            "subsystem": subsystem,
            "pillar": pillar,
            "is_curated": is_curated,
            "labels_json": json.dumps(labels, sort_keys=True, separators=(",", ":")),
            "label_hash": _label_hash(labels),
            "value": value,
        }


def count_rows(rows: Iterable[dict]) -> int:
    """Tiny helper used by the pipeline log line / tests."""
    return sum(1 for _ in rows)
