# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "dlt[postgres]",
#     "requests",
# ]
# ///
"""Supabase platform metrics → Postgres, via dlt.

Scrapes the project's privileged Prometheus metrics endpoint (host load,
database internals, service layer) and loads one row per series per run into
Postgres (the project's Supabase Postgres by default), so reliability / load /
performance can be tracked over time. dlt manages the schema and merge state in
the destination; the shaped reliability/load/performance rollups live in the SQL
views in ``views.sql``, which this pipeline (re)applies after every load.

This mirrors ``github_stats/`` exactly — same Postgres destination env, same
``views.sql`` re-apply, same workflow shape — but the source is Supabase's own
telemetry rather than the GitHub API. The samples land in their own
``supabase_metrics`` schema (NOT the RLS-public app tables); the dbt project
models them from there.

Config (all via env):
- ``SUPABASE_POSTGRES_URL`` (or ``SUPABASE_DB_URL`` / ``DLT_PG_URL``) — the
  Postgres connection string. Required to load. Use the session-pooler URL
  (IPv4) in CI; see github_stats/README.md.
- Metrics endpoint creds — see ``metrics_api.py``.

Run (see .github/workflows/supabase-stats.yml):
    uv run --with "dlt[postgres]" --with requests python pipeline.py
    uv run --with "dlt[postgres]" --with requests python pipeline.py --all
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import dlt

from metrics_api import SupabaseMetricsClient
from transforms import metric_rows

DATASET_NAME = "supabase_metrics"
PIPELINE_NAME = "supabase_metrics"
VIEWS_SQL_PATH = Path(__file__).resolve().parent / "views.sql"


@dlt.source(name="supabase_metrics")
def supabase_metrics_source(
    client: SupabaseMetricsClient | None = None,
    *,
    curated_only: bool = True,
    scraped_at: datetime | None = None,
):
    """dlt source emitting one ``metric_samples`` snapshot per invocation."""
    client = client or SupabaseMetricsClient()
    # One scrape time shared by every row in the run — the sample's identity in
    # time. Truncated to the second so retries within the same second merge.
    stamp = (scraped_at or datetime.now(timezone.utc)).replace(microsecond=0)

    @dlt.resource(
        name="metric_samples",
        # A series is (metric, label set); one sample per series per scrape time.
        primary_key=["scraped_at", "metric", "label_hash"],
        write_disposition="merge",
    )
    def metric_samples():
        text = client.fetch_metrics_text()
        yield from metric_rows(text, stamp, curated_only=curated_only)

    return metric_samples


def _resolve_pg_credentials() -> str | None:
    # Same env names as github_stats so one secret powers both exporters.
    return (
        os.environ.get("SUPABASE_POSTGRES_URL")
        or os.environ.get("SUPABASE_DB_URL")
        or os.environ.get("DLT_PG_URL")
    )


def _iter_sql_statements(sql: str):
    """Yield executable statements from a .sql file: strip full-line ``--``
    comments (each statement is preceded by a comment block, so a naive split
    would leave every statement starting with ``--``), then split on ``;``."""
    no_comments = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )
    for statement in no_comments.split(";"):
        statement = statement.strip()
        if statement:
            yield statement


def apply_views(pipeline: dlt.Pipeline, schema: str) -> None:
    """(Re)create the shaped views in the dataset schema (idempotent)."""
    sql = VIEWS_SQL_PATH.read_text(encoding="utf-8").replace("{schema}", schema)
    with pipeline.sql_client() as client:
        for statement in _iter_sql_statements(sql):
            client.execute_sql(statement)


def run(
    *,
    curated_only: bool = True,
    skip_views: bool = False,
):
    creds = _resolve_pg_credentials()
    if not creds:
        raise RuntimeError(
            "Set SUPABASE_POSTGRES_URL (or SUPABASE_DB_URL / DLT_PG_URL) to the Postgres "
            "connection string (postgresql://user:pass@host:5432/db) to load Supabase metrics."
        )

    client = SupabaseMetricsClient()
    if not client.configured:
        raise RuntimeError(client.missing_config_message())

    scope = "all metrics" if not curated_only else "curated metrics"
    print(f"Scraping Supabase privileged metrics ({scope}) → Postgres.{DATASET_NAME}")

    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.postgres(credentials=creds),
        dataset_name=DATASET_NAME,
    )
    source = supabase_metrics_source(client, curated_only=curated_only)
    info = pipeline.run(source)
    print(info)

    if not skip_views:
        apply_views(pipeline, DATASET_NAME)
        print(f"Applied shaped views to {DATASET_NAME}.")
    return info


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scrape Supabase privileged metrics into Postgres via dlt"
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Capture every series (incl. uncurated service metrics), not just the curated core",
    )
    parser.add_argument(
        "--skip-views", action="store_true", help="Load the raw table but don't (re)create the views"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    run(curated_only=not args.all, skip_views=args.skip_views)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
