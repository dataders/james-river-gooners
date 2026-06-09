# GitHub repo-stats pipeline (dlt → MotherDuck)

A [dlt](https://dlthub.com) pipeline that monitors this repo's GitHub activity
and loads it straight into **MotherDuck** (`md:my_db`, schema `github_stats`),
so repo health can be tracked over time:

- **Issues** — every issue (open/closed), so open vs. closed counts and
  open-by-day trends.
- **Pull requests** — state + `merged_at`, so open / merged / closed-unmerged
  counts and average time-to-merge.
- **Commits** — one row per commit (subject, author, date).
- **Workflow runs** — GitHub Actions runs with computed **run time**
  (`duration_seconds`) and conclusion, so **failure rate** and run-time
  percentiles per workflow.
- **Scraper "items processed"** (`scraper_run_metrics`) — counts parsed from
  each completed run's logs (`Wrote N items`, `Upserted N lots`,
  `Wrote N rows to ebay_comp_snapshots`, …). Best-effort: it greps the real
  count-lines the scrapers print; see `LOG_METRIC_PATTERNS` in `transforms.py`
  to add more.

## How it's shaped

dlt loads **raw entity tables** (one row per issue / PR / commit / run /
metric) incrementally with merge semantics into a dedicated **`github_stats`
schema in MotherDuck** (`my_db`). This data is **analytics-only** — it is *not*
read by the app/browser (unlike the RLS-public app tables in Supabase
Postgres), and its sole consumer is the MotherDuck dashboard. So it lands
directly in the warehouse the dashboard reads: **dlt writes the raw tables and
dbt transforms them in the same place, with no cross-database hop.**

The "stats" (counts, failure rate, run-time percentiles, items-processed
trends) are **dbt models** built on these raw tables — the `engineering` mart
layer in [`dbt/models/marts/engineering/`](../dbt/models/marts/engineering/),
materialized into `my_db.gooners_engineering`:

| dbt model | what |
| --- | --- |
| `fct_repo_overview` | single-row headline: open issues, merged PRs, avg hours-to-merge, … |
| `fct_workflow_run_health` | per-workflow total/failed runs, **failure_rate**, avg + p50/p95 **duration** |
| `fct_ci_run_daily` | per-day per-workflow runs/failures/failure_rate + 7d rolling rate |
| `fct_pull_request_activity` | per-PR drill-down with merge-speed buckets |
| `fct_repo_activity_daily` | PRs/issues/commits per day + rolling totals |
| `fct_scraper_items_daily` | items processed per metric per day |

## Configuration (env)

| var | purpose |
| --- | --- |
| `MOTHERDUCK_TOKEN` | **Required.** A read/write MotherDuck PAT. Builds the `md:my_db?motherduck_token=…` connection. (The read-scaling `MOTHERDUCK_READ_TOKEN` can't write and is not used.) |
| `GITHUB_TOKEN` / `GH_TOKEN` | Bumps the API rate limit and is **required to download workflow-run logs** (the items-processed source). Auto-set in GitHub Actions. |
| `GITHUB_REPOSITORY` | `owner/name` to monitor. Defaults to `dataders/james-river-gooners`. Auto-set in Actions. |

> MotherDuck is reached over HTTPS, so any runner (or sandbox) can load — no
> direct-DB / IPv6 / connection-pooler concerns.

## Run

```bash
cd github_stats
# Daily incremental (default 180-day lookback for first load / new entities):
uv run --with "dlt[motherduck]" --with requests python pipeline.py

# Wider backfill, more run-logs parsed:
uv run --with "dlt[motherduck]" --with requests python pipeline.py --lookback-days 365 --max-log-runs 200

# Other repo:
uv run --with "dlt[motherduck]" --with requests python pipeline.py --repo owner/name
```

The hourly schedule runs in [`.github/workflows/github-stats.yml`](../.github/workflows/github-stats.yml).

## Tests

```bash
cd github_stats
uv run --with requests --with pytest python -m pytest -q
```

Tests are hermetic (no network / dlt / MotherDuck): they cover the row
transforms, log-metric parsing, and the API client's pagination + log-zip
handling against a fake session.

## Notes

- **Workflow-run cap:** GitHub paginates `/actions/runs` to ~1000 most-recent
  runs, so a very wide lookback still tops out there. The daily incremental keeps
  up regardless.
- **dlt state** lives in the destination (`_dlt_*` tables in the `github_stats`
  schema) — nothing is committed, so CI is stateless.
- The pipeline raises if `MOTHERDUCK_TOKEN` is unset; the workflow skips cleanly
  when the secret is absent.
