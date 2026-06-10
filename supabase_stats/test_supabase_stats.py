"""Hermetic tests for the Supabase-stats exporter.

No network, no dlt, no Postgres: they cover the Prometheus parser, metric
classification, and the metrics client against a fake session.

    cd supabase_stats
    uv run --with requests --with pytest python -m pytest -q
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from metrics_api import SupabaseMetricsClient, _derive_metrics_url
from transforms import (
    classify,
    metric_rows,
    metric_type_for,
    parse_metric_line,
    parse_type_lines,
)

SAMPLE = """\
# HELP node_load1 1m load average.
# TYPE node_load1 gauge
node_load1 0.42
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 12345.6
node_cpu_seconds_total{cpu="0",mode="user"} 678.9
# HELP pg_stat_database_blks_hit_total Blocks found in buffer cache.
# TYPE pg_stat_database_blks_hit_total counter
pg_stat_database_blks_hit_total{server="localhost:5432"} 1000
pg_stat_database_blks_hit_total{server="other:5432"} NaN
# HELP connection_stats_connection_count Current connections by username.
# TYPE connection_stats_connection_count gauge
connection_stats_connection_count{username="authenticator"} 3
connection_stats_connection_count{username="supabase_admin"} 7
# HELP some_unknown_service_metric A metric we don't curate.
# TYPE some_unknown_service_metric gauge
some_unknown_service_metric{label="with, comma and \\"quote\\""} 5
"""


def test_parse_type_lines():
    types = parse_type_lines(SAMPLE)
    assert types["node_load1"] == "gauge"
    assert types["node_cpu_seconds_total"] == "counter"
    assert types["pg_stat_database_blks_hit_total"] == "counter"


def test_metric_type_for_handles_histogram_suffixes():
    types = {"http_request_duration_seconds": "histogram"}
    assert metric_type_for("http_request_duration_seconds_bucket", types) == "counter"
    assert metric_type_for("http_request_duration_seconds_sum", types) == "counter"
    assert metric_type_for("totally_unknown", types) == "untyped"


def test_parse_metric_line_no_labels():
    assert parse_metric_line("node_load1 0.42") == ("node_load1", {}, 0.42)


def test_parse_metric_line_with_labels():
    name, labels, value = parse_metric_line('node_cpu_seconds_total{cpu="0",mode="idle"} 12345.6')
    assert name == "node_cpu_seconds_total"
    assert labels == {"cpu": "0", "mode": "idle"}
    assert value == 12345.6


def test_parse_metric_line_handles_escaped_label_values():
    name, labels, value = parse_metric_line(
        'some_metric{label="with, comma and \\"quote\\""} 5'
    )
    assert name == "some_metric"
    assert labels == {"label": 'with, comma and "quote"'}
    assert value == 5.0


def test_parse_metric_line_drops_nan_and_comments():
    assert parse_metric_line("pg_x{datname=\"t\"} NaN") is None
    assert parse_metric_line("# HELP foo bar") is None
    assert parse_metric_line("") is None


def test_parse_metric_line_ignores_trailing_timestamp():
    assert parse_metric_line("node_load1 0.42 1700000000000") == ("node_load1", {}, 0.42)


def test_classify_longest_prefix_and_pillars():
    assert classify("node_load1") == ("host", "load", True)
    assert classify("node_disk_io_time_seconds_total") == ("host", "performance", True)
    # _total suffix still matches the prefix; sub-breakdowns inherit the tag.
    assert classify("pg_stat_database_xact_rollback_total") == ("database", "reliability", True)
    assert classify("pg_stat_database_conflicts_confl_lock_total") == ("database", "reliability", True)
    assert classify("connection_stats_connection_count") == ("database", "load", True)
    assert classify("pgrst_db_pool_waiting") == ("postgrest", "reliability", True)
    assert classify("some_unknown_service_metric") == ("other", None, False)


def test_metric_rows_curated_only_skips_uncurated():
    ts = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)
    rows = list(metric_rows(SAMPLE, ts, curated_only=True))
    metrics = {r["metric"] for r in rows}
    assert "some_unknown_service_metric" not in metrics
    assert "node_load1" in metrics
    # NaN sample dropped, both connection series kept.
    blks = [r for r in rows if r["metric"] == "pg_stat_database_blks_hit_total"]
    assert len(blks) == 1 and blks[0]["value"] == 1000.0
    conns = [r for r in rows if r["metric"] == "connection_stats_connection_count"]
    assert {json.loads(r["labels_json"])["username"] for r in conns} == {"authenticator", "supabase_admin"}


def test_metric_rows_all_includes_uncurated():
    ts = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)
    rows = list(metric_rows(SAMPLE, ts, curated_only=False))
    other = [r for r in rows if r["metric"] == "some_unknown_service_metric"]
    assert len(other) == 1
    assert other[0]["subsystem"] == "other"
    assert other[0]["pillar"] is None
    assert other[0]["is_curated"] is False


def test_metric_rows_stamps_and_hashes():
    ts = datetime(2026, 6, 9, 12, 0, 0, tzinfo=timezone.utc)
    rows = list(metric_rows(SAMPLE, ts))
    assert all(r["scraped_at"] == ts for r in rows)
    # Same series → same label_hash; different labels → different hash.
    cpu = {json.loads(r["labels_json"])["mode"]: r["label_hash"]
           for r in rows if r["metric"] == "node_cpu_seconds_total"}
    assert cpu["idle"] != cpu["user"]


# --- client ---------------------------------------------------------------

def test_derive_metrics_url_from_supabase_url():
    assert (
        _derive_metrics_url(None, "https://abc.supabase.co")
        == "https://abc.supabase.co/customer/v1/privileged/metrics"
    )
    # Explicit URL wins, query/path on SUPABASE_URL is replaced.
    assert _derive_metrics_url("https://x/metrics", "https://abc.supabase.co") == "https://x/metrics"
    assert _derive_metrics_url(None, None) is None


class _FakeResponse:
    def __init__(self, text, status_code=200):
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeSession:
    def __init__(self, response):
        self._response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self._response


def test_client_configured_and_fetch():
    session = _FakeSession(_FakeResponse(SAMPLE))
    client = SupabaseMetricsClient(
        url="https://abc.supabase.co/customer/v1/privileged/metrics",
        password="secret",
        session=session,
    )
    assert client.configured
    text = client.fetch_metrics_text()
    assert "node_load1" in text
    url, kwargs = session.calls[0]
    assert kwargs["auth"] == ("service_role", "secret")


def test_client_unconfigured_raises(monkeypatch):
    for var in (
        "SUPABASE_METRICS_URL",
        "SUPABASE_URL",
        "VITE_SUPABASE_URL",
        "SUPABASE_METRICS_PASSWORD",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
    ):
        monkeypatch.delenv(var, raising=False)
    client = SupabaseMetricsClient()
    assert not client.configured
    with pytest.raises(RuntimeError):
        client.fetch_metrics_text()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
