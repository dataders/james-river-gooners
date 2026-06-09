"""GitHub repository-stats → Postgres, via dlt.

Pulls issues, pull requests, commits, and Actions workflow runs from the GitHub
REST API and loads them as raw rows into Postgres (the project's Supabase
Postgres by default), plus a ``scraper_run_metrics`` table of "items processed"
counts parsed from each scrape run's logs. dlt manages the schema and incremental
state; the derived stats (open/merged counts, workflow failure rate + run-time
percentiles, items-processed trends) live in the SQL views in ``views.sql``,
which this pipeline (re)applies after every load.

Why dlt + a direct Postgres connection (not the PostgREST upserts the scrapers
use): these are raw entity tables dlt creates and schema-migrates itself, loaded
incrementally with merge semantics — exactly dlt's job. They are NOT the
RLS-public app tables; they live in their own ``github_stats`` schema.

Config (all via env):
- ``SUPABASE_DB_URL`` / ``DLT_PG_URL`` — the Postgres connection string
  (``postgresql://user:pass@host:5432/db``). Required to load.
- ``GITHUB_TOKEN`` / ``GH_TOKEN`` — bumps the API rate limit (and is required for
  log download); set automatically in GitHub Actions.
- ``GITHUB_REPOSITORY`` — ``owner/name`` to monitor; defaults to the project repo.

Run (see .github/workflows/github-stats.yml):
    uv run --with "dlt[postgres]" --with requests python pipeline.py
    uv run --with "dlt[postgres]" --with requests python pipeline.py --lookback-days 365
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import dlt

from github_api import GitHubClient, resolve_repo
from transforms import (
    commit_row,
    issue_row,
    parse_log_metrics,
    pull_request_row,
    scraper_run_metric_rows,
    workflow_run_row,
)

DATASET_NAME = "github_stats"
PIPELINE_NAME = "github_stats"
DEFAULT_LOOKBACK_DAYS = 180
# Bound how many run logs we download per invocation (each is a zip fetch).
DEFAULT_MAX_LOG_RUNS = 60
VIEWS_SQL_PATH = Path(__file__).resolve().parent / "views.sql"


def _lookback_start(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


@dlt.source(name="github_stats")
def github_source(
    repo: str | None = None,
    token: str | None = None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    max_log_runs: int = DEFAULT_MAX_LOG_RUNS,
):
    """dlt source bundling the GitHub-stats resources for one repo."""
    client = GitHubClient(repo=repo, token=token)
    start = _lookback_start(lookback_days)

    @dlt.resource(name="issues", primary_key="id", write_disposition="merge")
    def issues(
        updated_at=dlt.sources.incremental("updated_at", initial_value=start),
    ):
        # /issues returns PRs too; keep them out of the issues table.
        since = updated_at.last_value or start
        for raw in client.paginate(
            "issues",
            {"state": "all", "since": since.isoformat(), "sort": "updated", "direction": "asc"},
        ):
            row = issue_row(raw)
            if not row["is_pull_request"]:
                yield row

    @dlt.resource(name="pull_requests", primary_key="id", write_disposition="merge")
    def pull_requests(
        updated_at=dlt.sources.incremental("updated_at", initial_value=start),
    ):
        # /pulls has no `since`; sorted newest-first, stop once we cross the cursor.
        boundary = updated_at.start_value or start
        for raw in client.paginate(
            "pulls", {"state": "all", "sort": "updated", "direction": "desc"}
        ):
            row = pull_request_row(raw)
            if row["updated_at"] and row["updated_at"] < boundary:
                break
            yield row

    @dlt.resource(name="commits", primary_key="sha", write_disposition="merge")
    def commits(
        authored_at=dlt.sources.incremental("authored_at", initial_value=start),
    ):
        since = authored_at.last_value or start
        for raw in client.paginate("commits", {"since": since.isoformat()}):
            yield commit_row(raw)

    @dlt.resource(name="workflow_runs", primary_key="id", write_disposition="merge")
    def workflow_runs(
        created_at=dlt.sources.incremental("created_at", initial_value=start),
    ):
        since = created_at.last_value or start
        for raw in client.paginate_wrapped(
            "actions/runs", "workflow_runs", {"created": f">={since.date().isoformat()}"}
        ):
            yield workflow_run_row(raw)

    @dlt.resource(
        name="scraper_run_metrics",
        primary_key=["run_id", "metric"],
        write_disposition="merge",
    )
    def scraper_run_metrics(
        run_started_at=dlt.sources.incremental("run_started_at", initial_value=start),
    ):
        """Items processed, parsed from each completed run's logs.

        Bounded to ``max_log_runs`` newest completed runs since the cursor so a
        backfill can't download thousands of log zips in one go; dlt's cursor
        then advances so the next run only sees newer runs.
        """
        boundary = run_started_at.start_value or start
        downloaded = 0
        for raw in client.paginate_wrapped(
            "actions/runs",
            "workflow_runs",
            {"status": "completed", "created": f">={boundary.date().isoformat()}"},
        ):
            run = workflow_run_row(raw)
            started = run.get("run_started_at")
            if started and started < boundary:
                continue
            if downloaded >= max_log_runs:
                break
            text = client.run_log_text(raw.get("id"))
            downloaded += 1
            if not text:
                continue
            totals = parse_log_metrics(text)
            # Re-attach run_started_at as the dlt cursor field on each emitted row.
            for metric_row in scraper_run_metric_rows(raw, totals):
                metric_row["run_started_at"] = started
                yield metric_row

    return issues, pull_requests, commits, workflow_runs, scraper_run_metrics


def _resolve_pg_credentials() -> str | None:
    return os.environ.get("SUPABASE_DB_URL") or os.environ.get("DLT_PG_URL")


def _iter_sql_statements(sql: str):
    """Yield executable statements from a .sql file: strip full-line ``--``
    comments (each statement here is preceded by a comment block, so a naive
    split would leave every statement starting with ``--``), then split on ``;``."""
    no_comments = "\n".join(
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    )
    for statement in no_comments.split(";"):
        statement = statement.strip()
        if statement:
            yield statement


def apply_views(pipeline: dlt.Pipeline, schema: str) -> None:
    """(Re)create the derived views in the dataset schema (idempotent)."""
    sql = VIEWS_SQL_PATH.read_text(encoding="utf-8").replace("{schema}", schema)
    with pipeline.sql_client() as client:
        for statement in _iter_sql_statements(sql):
            client.execute_sql(statement)


def run(
    repo: str | None = None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    max_log_runs: int = DEFAULT_MAX_LOG_RUNS,
    skip_views: bool = False,
):
    creds = _resolve_pg_credentials()
    if not creds:
        raise RuntimeError(
            "Set SUPABASE_DB_URL (or DLT_PG_URL) to the Postgres connection string "
            "(postgresql://user:pass@host:5432/db) to load GitHub stats."
        )

    repo = resolve_repo(repo)
    print(f"Loading GitHub stats for {repo} (lookback {lookback_days}d) → Postgres.{DATASET_NAME}")

    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.postgres(credentials=creds),
        dataset_name=DATASET_NAME,
    )
    source = github_source(repo=repo, lookback_days=lookback_days, max_log_runs=max_log_runs)
    info = pipeline.run(source)
    print(info)

    if not skip_views:
        apply_views(pipeline, DATASET_NAME)
        print(f"Applied derived views to {DATASET_NAME}.")
    return info


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load GitHub repo stats into Postgres via dlt")
    parser.add_argument("--repo", help="owner/name to monitor (default: GITHUB_REPOSITORY or project repo)")
    parser.add_argument(
        "--lookback-days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help=f"How far back to pull on first load / for new entities (default {DEFAULT_LOOKBACK_DAYS})",
    )
    parser.add_argument(
        "--max-log-runs",
        type=int,
        default=DEFAULT_MAX_LOG_RUNS,
        help=f"Cap on workflow-run logs downloaded per invocation (default {DEFAULT_MAX_LOG_RUNS})",
    )
    parser.add_argument(
        "--skip-views", action="store_true", help="Load raw tables but don't (re)create the views"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    run(
        repo=args.repo,
        lookback_days=args.lookback_days,
        max_log_runs=args.max_log_runs,
        skip_views=args.skip_views,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
