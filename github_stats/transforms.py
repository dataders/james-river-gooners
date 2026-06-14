"""Pure row-shaping helpers for the GitHub-stats dlt pipeline.

No network, no dlt — just functions that turn raw GitHub REST payloads into the
flat row dicts dlt loads into Postgres, plus the log-line regexes that extract
"items processed" counts from a workflow run's logs. Kept separate from
``github_api`` so the projection logic is unit-testable without HTTP.
"""

from __future__ import annotations

import re
from datetime import datetime, UTC


def _parse_dt(value: str | None) -> datetime | None:
    """Parse a GitHub ISO-8601 timestamp (``2024-01-02T03:04:05Z``) to aware UTC."""
    if not value:
        return None
    try:
        # GitHub uses a trailing "Z"; fromisoformat handles "+00:00".
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except (ValueError, AttributeError):
        return None


def _duration_seconds(start: str | None, end: str | None) -> float | None:
    a, b = _parse_dt(start), _parse_dt(end)
    if a is None or b is None:
        return None
    delta = (b - a).total_seconds()
    return delta if delta >= 0 else None


def issue_row(issue: dict) -> dict:
    """Project a GitHub issue (from /issues) onto an ``issues`` row.

    The /issues endpoint also returns pull requests (they carry a
    ``pull_request`` key); ``is_pull_request`` lets the caller filter them out so
    the issues table stays issues-only.
    """
    user = issue.get("user") or {}
    labels = issue.get("labels") or []
    return {
        "id": issue.get("id"),
        "number": issue.get("number"),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "user_login": user.get("login"),
        "comments": issue.get("comments"),
        "labels": [lbl.get("name") for lbl in labels if isinstance(lbl, dict)],
        "is_pull_request": "pull_request" in issue,
        "created_at": _parse_dt(issue.get("created_at")),
        "updated_at": _parse_dt(issue.get("updated_at")),
        "closed_at": _parse_dt(issue.get("closed_at")),
        "html_url": issue.get("html_url"),
    }


def pull_request_row(pr: dict) -> dict:
    """Project a GitHub pull request (from /pulls) onto a ``pull_requests`` row."""
    user = pr.get("user") or {}
    merged_at = _parse_dt(pr.get("merged_at"))
    created_at = _parse_dt(pr.get("created_at"))
    return {
        "id": pr.get("id"),
        "number": pr.get("number"),
        "title": pr.get("title"),
        "state": pr.get("state"),
        "user_login": user.get("login"),
        "draft": bool(pr.get("draft")),
        "merged": merged_at is not None,
        "created_at": created_at,
        "updated_at": _parse_dt(pr.get("updated_at")),
        "closed_at": _parse_dt(pr.get("closed_at")),
        "merged_at": merged_at,
        # Hours from open to merge — feeds avg time-to-merge in the views.
        "hours_to_merge": (
            round((merged_at - created_at).total_seconds() / 3600.0, 3)
            if merged_at and created_at
            else None
        ),
        "base_ref": (pr.get("base") or {}).get("ref"),
        "html_url": pr.get("html_url"),
    }


def commit_row(commit: dict) -> dict:
    """Project a GitHub commit (from /commits) onto a ``commits`` row."""
    inner = commit.get("commit") or {}
    author_meta = inner.get("author") or {}
    author = commit.get("author") or {}
    message = inner.get("message") or ""
    return {
        "sha": commit.get("sha"),
        "author_login": author.get("login"),
        "author_name": author_meta.get("name"),
        "authored_at": _parse_dt(author_meta.get("date")),
        # First line of the message — the subject, not the whole body.
        "message": message.splitlines()[0] if message else None,
        "html_url": commit.get("html_url"),
    }


# Conclusions GitHub reports for a *completed* run. Anything not in SUCCESSFUL is
# counted as a failure by the views (timed_out / cancelled / failure / etc.).
SUCCESSFUL_CONCLUSIONS = {"success", "skipped", "neutral"}


def workflow_run_row(run: dict) -> dict:
    """Project a GitHub Actions run (from /actions/runs) onto a ``workflow_runs`` row."""
    started = run.get("run_started_at")
    updated = run.get("updated_at")
    conclusion = run.get("conclusion")
    completed = run.get("status") == "completed"
    return {
        "id": run.get("id"),
        "name": run.get("name"),
        "workflow_id": run.get("workflow_id"),
        "head_branch": run.get("head_branch"),
        "event": run.get("event"),
        "status": run.get("status"),
        "conclusion": conclusion,
        "run_number": run.get("run_number"),
        "run_attempt": run.get("run_attempt"),
        "created_at": _parse_dt(run.get("created_at")),
        "updated_at": _parse_dt(updated),
        "run_started_at": _parse_dt(started),
        # Wall-clock seconds from start to last update (≈ run duration).
        "duration_seconds": _duration_seconds(started, updated),
        # Only meaningful once completed; null while in progress.
        "succeeded": (conclusion in SUCCESSFUL_CONCLUSIONS) if completed else None,
        "failed": (conclusion not in SUCCESSFUL_CONCLUSIONS) if completed else None,
        "html_url": run.get("html_url"),
    }


# "Items processed" extracted from a run's logs. Each entry is
# (metric_name, regex with one integer capture group); a metric may match many
# lines in a run (e.g. one "Wrote N items" per auction), so values are summed.
# These target the real count-lines the scrapers print (see scraper/*.py).
LOG_METRIC_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("items_scraped", re.compile(r"Wrote (\d+) items")),
    ("lots_fetched", re.compile(r"Fetched (\d+) lots")),
    ("lots_upserted", re.compile(r"Upserted (\d+) lots")),
    ("sold_lots_upserted", re.compile(r"Upserted (\d+) sold lot")),
    ("comp_rows_written", re.compile(r"Wrote (\d+) rows to ebay_comp_snapshots")),
    ("enrichment_rows_upserted", re.compile(r"[Uu]pserted (\d+) enrichment row")),
    ("nomic_embeddings_upserted", re.compile(r"Upserted (\d+) embeddings")),
    ("closed_lots_finalized", re.compile(r"Finalized (\d+) closed lots")),
]


def parse_log_metrics(log_text: str) -> dict[str, int]:
    """Sum every ``LOG_METRIC_PATTERNS`` match in a run's combined log text.

    Returns ``{metric_name: total}`` for the metrics that appeared at least once;
    a metric with no matches is omitted (so a run that scraped nothing yields no
    items_scraped row rather than a zero).
    """
    totals: dict[str, int] = {}
    for metric, pattern in LOG_METRIC_PATTERNS:
        matches = pattern.findall(log_text)
        if matches:
            totals[metric] = sum(int(m) for m in matches)
    return totals


def scraper_run_metric_rows(run: dict, totals: dict[str, int]) -> list[dict]:
    """Flatten one run's parsed log totals into ``scraper_run_metrics`` rows.

    One row per (run_id, metric); merge-keyed on that pair so re-parsing a run
    overwrites rather than duplicates.
    """
    run_id = run.get("id")
    rows = []
    for metric, value in totals.items():
        rows.append(
            {
                "run_id": run_id,
                "metric": metric,
                "value": value,
                "workflow_name": run.get("name"),
                "head_branch": run.get("head_branch"),
                "event": run.get("event"),
                "conclusion": run.get("conclusion"),
                "run_started_at": _parse_dt(run.get("run_started_at")),
            }
        )
    return rows
