# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "dlt[motherduck]",
#     "requests",
# ]
# ///
"""GitHub repository-stats → MotherDuck, via dlt.

Pulls issues, pull requests, commits, and Actions workflow runs from the GitHub
REST API and loads them as raw rows into MotherDuck (``md:my_db``, schema
``github_stats``), plus a ``scraper_run_metrics`` table of "items processed"
counts parsed from each scrape run's logs. dlt manages the schema and incremental
state. The derived stats (failure rate + run-time percentiles, throughput
trends) are dbt models built on these raw tables (see dbt/models/marts/
engineering/), so this pipeline only lands the raw entities.

This data is analytics-only — it is NOT read by the app/browser (unlike the
RLS-public app tables in Supabase Postgres). Its sole consumer is the MotherDuck
dashboard, so it loads straight into MotherDuck: dlt writes the raw tables and
dbt transforms them in the same warehouse, no cross-database hop.

Config (all via env):
- ``MOTHERDUCK_TOKEN`` — a read/write MotherDuck PAT. Required to load.
  (The read-scaling ``MOTHERDUCK_READ_TOKEN`` cannot write and is not used here.)
- ``GITHUB_TOKEN`` / ``GH_TOKEN`` — bumps the API rate limit (and is required for
  log download); set automatically in GitHub Actions.
- ``GITHUB_REPOSITORY`` — ``owner/name`` to monitor; defaults to the project repo.

Run (see .github/workflows/github-stats.yml):
    uv run --with "dlt[motherduck]" --with requests python pipeline.py
    uv run --with "dlt[motherduck]" --with requests python pipeline.py --lookback-days 365
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

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
# MotherDuck database the dbt project also targets (md:my_db). Raw tables land
# in my_db.github_stats; dbt builds the engineering marts in the same database.
MD_DATABASE = "my_db"
DEFAULT_LOOKBACK_DAYS = 180
# Bound how many run logs we download per invocation (each is a zip fetch).
DEFAULT_MAX_LOG_RUNS = 60


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


def _resolve_motherduck_credentials() -> str | None:
    # Build the MotherDuck connection string for md:my_db from the write PAT.
    # MOTHERDUCK_READ_TOKEN is read-scaling (read-only) and can't write, so it's
    # intentionally not accepted here.
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        return None
    return f"md:{MD_DATABASE}?motherduck_token={token}"


def run(
    repo: str | None = None,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    max_log_runs: int = DEFAULT_MAX_LOG_RUNS,
):
    creds = _resolve_motherduck_credentials()
    if not creds:
        raise RuntimeError(
            "Set MOTHERDUCK_TOKEN (a read/write MotherDuck PAT) to load GitHub stats "
            f"into MotherDuck ({MD_DATABASE}.{DATASET_NAME})."
        )

    repo = resolve_repo(repo)
    print(f"Loading GitHub stats for {repo} (lookback {lookback_days}d) → MotherDuck {MD_DATABASE}.{DATASET_NAME}")

    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.motherduck(credentials=creds),
        dataset_name=DATASET_NAME,
    )
    source = github_source(repo=repo, lookback_days=lookback_days, max_log_runs=max_log_runs)
    info = pipeline.run(source)
    print(info)
    return info


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Load GitHub repo stats into MotherDuck via dlt")
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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    run(
        repo=args.repo,
        lookback_days=args.lookback_days,
        max_log_runs=args.max_log_runs,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
