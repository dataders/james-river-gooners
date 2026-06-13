# Pipeline metrics capture (dbt + dlt → MotherDuck `meta`)

Observability for the analytics pipeline itself. The dlt copy + dbt build emit
rich per-run detail every time — rows loaded, each model's status/rows/runtime,
every test pass/fail — but it's printed to logs and thrown away (dbt's `target/`
is ephemeral). `capture.py` records it into MotherDuck so it can be monitored
over time:

| table | grain | from |
| --- | --- | --- |
| `meta.dbt_run_results` | one row per node per `dbt build` invocation | `dbt/target/run_results.json` — `resource_type`, `status`, `rows_affected`, `execution_time`, `message` |
| `meta.source_row_counts` | one row per source table per capture | live `count(*)` of the warehouse-native source tables (`supabase_app.*`, `github_stats.*`, `posthog_raw.*`, `supabase_metrics.*`) |

The admin dashboard's **Pipeline Health** tab reads these: last-build status,
dbt test pass-rate over time, rows-processed per table, and the slowest models.

## Configuration (env)

| var | purpose |
| --- | --- |
| `MOTHERDUCK_TOKEN` | **Required.** Read/write MotherDuck PAT. |

## Run

```bash
cd pipeline_meta
# After a dbt build has written ../dbt/target/run_results.json:
MOTHERDUCK_TOKEN=... uv run --with 'duckdb==1.5.2' python capture.py --target-dir ../dbt/target
```

Runs automatically right after `dbt build` in
[`.github/workflows/admin-dashboard.yml`](../.github/workflows/admin-dashboard.yml),
so each refresh appends a row of pipeline health.

## Tests

```bash
cd pipeline_meta
uv run --with pytest python -m pytest -q
```

Hermetic (no DuckDB / MotherDuck): duckdb is imported lazily inside `_connect()`,
so the `run_results.json` parsing is covered in isolation.
