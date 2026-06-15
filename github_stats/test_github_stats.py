"""Unit tests for the GitHub-stats pipeline's pure transforms + API client.

Hermetic: no network, no dlt, no Postgres. Covers row projection, log-metric
parsing, and the client's pagination + log-zip handling against a fake session.
"""

import io
import zipfile
from datetime import UTC, datetime

import pytest
from github_api import GitHubClient, resolve_repo, resolve_token
from transforms import (
    _duration_seconds,
    _parse_dt,
    commit_row,
    issue_row,
    parse_log_metrics,
    pull_request_row,
    scraper_run_metric_rows,
    workflow_run_row,
)


def test_parse_dt_handles_z_suffix_and_none():
    dt = _parse_dt("2024-01-02T03:04:05Z")
    assert dt == datetime(2024, 1, 2, 3, 4, 5, tzinfo=UTC)
    assert _parse_dt(None) is None
    assert _parse_dt("not-a-date") is None


def test_duration_seconds():
    assert _duration_seconds("2024-01-01T00:00:00Z", "2024-01-01T00:01:30Z") == 90.0
    # Negative (clock skew) is dropped, missing endpoints → None.
    assert _duration_seconds("2024-01-01T00:01:00Z", "2024-01-01T00:00:00Z") is None
    assert _duration_seconds(None, "2024-01-01T00:00:00Z") is None


def test_issue_row_flags_pull_requests():
    issue = {
        "id": 1,
        "number": 10,
        "title": "Bug",
        "state": "open",
        "user": {"login": "alice"},
        "comments": 2,
        "labels": [{"name": "bug"}, {"name": "p1"}],
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": "2024-01-02T00:00:00Z",
        "closed_at": None,
    }
    row = issue_row(issue)
    assert row["is_pull_request"] is False
    assert row["labels"] == ["bug", "p1"]
    assert row["user_login"] == "alice"
    assert row["closed_at"] is None

    pr_as_issue = {**issue, "pull_request": {"url": "..."}}
    assert issue_row(pr_as_issue)["is_pull_request"] is True


def test_pull_request_row_merge_fields():
    merged = pull_request_row(
        {
            "id": 5,
            "number": 3,
            "title": "Feature",
            "state": "closed",
            "user": {"login": "bob"},
            "draft": False,
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T12:00:00Z",
            "closed_at": "2024-01-01T12:00:00Z",
            "merged_at": "2024-01-01T12:00:00Z",
            "base": {"ref": "main"},
        }
    )
    assert merged["merged"] is True
    assert merged["hours_to_merge"] == 12.0
    assert merged["base_ref"] == "main"

    open_pr = pull_request_row(
        {
            "id": 6,
            "state": "open",
            "created_at": "2024-01-01T00:00:00Z",
            "merged_at": None,
        }
    )
    assert open_pr["merged"] is False
    assert open_pr["hours_to_merge"] is None


def test_commit_row_takes_subject_line():
    row = commit_row(
        {
            "sha": "abc123",
            "author": {"login": "carol"},
            "commit": {
                "author": {"name": "Carol", "date": "2024-01-01T00:00:00Z"},
                "message": "Fix thing\n\nLong body here",
            },
        }
    )
    assert row["sha"] == "abc123"
    assert row["message"] == "Fix thing"
    assert row["author_login"] == "carol"


def test_workflow_run_row_success_failure_duration():
    success = workflow_run_row(
        {
            "id": 99,
            "name": "Test",
            "status": "completed",
            "conclusion": "success",
            "created_at": "2024-01-01T00:00:00Z",
            "run_started_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:02:00Z",
        }
    )
    assert success["succeeded"] is True
    assert success["failed"] is False
    assert success["duration_seconds"] == 120.0

    failed = workflow_run_row({"id": 1, "status": "completed", "conclusion": "failure"})
    assert failed["failed"] is True and failed["succeeded"] is False

    # Cancelled counts as a failure; in-progress runs have null flags.
    assert workflow_run_row(
        {"id": 2, "status": "completed", "conclusion": "cancelled"}
    )["failed"]
    in_progress = workflow_run_row(
        {"id": 3, "status": "in_progress", "conclusion": None}
    )
    assert in_progress["failed"] is None and in_progress["succeeded"] is None


def test_parse_log_metrics_sums_repeated_lines():
    log = (
        "  Wrote 50 items → a.ndjson\n"
        "  Wrote 30 items → b.ndjson\n"
        "  Fetched 80 lots\n"
        "Upserted 12 sold lot(s) from Supabase\n"
        "Wrote 7 rows to ebay_comp_snapshots.\n"
        "nothing else here\n"
    )
    totals = parse_log_metrics(log)
    assert totals["items_scraped"] == 80  # 50 + 30
    assert totals["lots_fetched"] == 80
    assert totals["sold_lots_upserted"] == 12
    assert totals["comp_rows_written"] == 7
    # No nomic line → metric absent (not zero).
    assert "nomic_embeddings_upserted" not in totals


def test_scraper_run_metric_rows():
    run = {
        "id": 555,
        "name": "Scrape Auction Data",
        "head_branch": "main",
        "event": "schedule",
        "conclusion": "success",
        "run_started_at": "2024-01-01T00:00:00Z",
    }
    rows = scraper_run_metric_rows(run, {"items_scraped": 80, "lots_fetched": 80})
    assert {r["metric"] for r in rows} == {"items_scraped", "lots_fetched"}
    assert all(r["run_id"] == 555 for r in rows)
    assert all(r["run_started_at"] == _parse_dt("2024-01-01T00:00:00Z") for r in rows)


# --- API client (fake session) ---------------------------------------------


class _FakeResponse:
    def __init__(self, *, json_data=None, content=b"", status_code=200, links=None):
        self._json = json_data
        self.content = content
        self.status_code = status_code
        self.links = links or {}
        self.headers = {}

    def json(self):
        return self._json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")


class _FakeSession:
    """Returns queued responses in order; records requested URLs."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.headers = {}
        self.requested = []

    def get(self, url, params=None, timeout=None):
        self.requested.append((url, params))
        return self._responses.pop(0)


def test_paginate_follows_link_header():
    page1 = _FakeResponse(
        json_data=[{"id": 1}, {"id": 2}],
        links={"next": {"url": "https://api.github.com/repos/o/r/issues?page=2"}},
    )
    page2 = _FakeResponse(json_data=[{"id": 3}])
    session = _FakeSession([page1, page2])
    client = GitHubClient(repo="o/r", token="t", session=session)

    items = list(client.paginate("issues", {"state": "all"}))
    assert [i["id"] for i in items] == [1, 2, 3]
    # First call carries params incl. per_page; the second follows the bare next URL.
    assert session.requested[0][1]["per_page"] == 100
    assert session.requested[1][1] is None


def test_paginate_wrapped_reads_key_and_stops_when_empty():
    page1 = _FakeResponse(json_data={"workflow_runs": [{"id": 1}]})
    session = _FakeSession([page1])
    client = GitHubClient(repo="o/r", token="t", session=session)
    runs = list(client.paginate_wrapped("actions/runs", "workflow_runs"))
    assert [r["id"] for r in runs] == [1]


def test_run_log_text_extracts_txt_from_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("0_build.txt", "Wrote 5 items")
        zf.writestr("ignored.bin", b"\x00\x01")
    session = _FakeSession([_FakeResponse(content=buf.getvalue())])
    client = GitHubClient(repo="o/r", token="t", session=session)
    text = client.run_log_text(123)
    assert "Wrote 5 items" in text


def test_run_log_text_returns_empty_on_404():
    session = _FakeSession([_FakeResponse(status_code=404)])
    client = GitHubClient(repo="o/r", token="t", session=session)
    assert client.run_log_text(123) == ""


def test_resolve_repo_and_token(monkeypatch):
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    assert resolve_repo("a/b") == "a/b"
    assert resolve_repo() == "dataders/james-river-gooners"
    monkeypatch.setenv("GITHUB_REPOSITORY", "x/y")
    assert resolve_repo() == "x/y"

    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert resolve_token() is None
    monkeypatch.setenv("GH_TOKEN", "tok")
    assert resolve_token() == "tok"
    assert resolve_token("explicit") == "explicit"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
