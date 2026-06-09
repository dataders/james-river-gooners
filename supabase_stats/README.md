# Supabase platform-metrics pipeline (dlt → Postgres)

A [dlt](https://dlthub.com) pipeline that scrapes Supabase's **privileged
Prometheus metrics endpoint** and loads it into Postgres (the project's Supabase
Postgres by default), so the platform's **reliability, load, and performance**
can be tracked over time. It is the sibling of [`github_stats/`](../github_stats)
— same Postgres destination, same `views.sql` re-apply, same hourly workflow —
but the source is Supabase's own infrastructure telemetry.

## What it collects

Supabase exposes a per-project Prometheus snapshot at
`https://<ref>.supabase.co/customer/v1/privileged/metrics` (HTTP Basic auth).
Each scrape is a point-in-time sample of:

- **Host load** (`node_exporter`) — load averages, CPU seconds, memory, disk
  usage/IO, network bytes, file descriptors.
- **Database** (`postgres_exporter`) — connections vs `max_connections`, commit
  / rollback / deadlock / conflict counters, buffer cache hits vs reads, db size,
  bgwriter/checkpoint activity, replication lag.
- **Service layer** (best-effort) — auth / storage / realtime / pooler metrics.

Each is tagged with a **`subsystem`** (host / database / auth / …) and a
reliability/load/performance **`pillar`** (longest-prefix match in
`transforms.CURATED`). The curated core (the well-documented node/pg families)
loads by default; `--all` also captures uncurated service metrics, tagged
`subsystem='other'`.

## How it's shaped

dlt loads one **raw long-format table** — `metric_samples`, one row per
`(scraped_at, metric, label set)` with `value`, `metric_type` (counter/gauge),
`subsystem`, and `pillar` — incrementally (merge on the series + scrape time)
into a dedicated **`supabase_metrics` Postgres schema**. This is *not* an
RLS-public app table; it's an analytics dataset dlt creates and schema-migrates
itself.

The shaped reliability/load/performance answers are **SQL views** in
[`views.sql`](./views.sql), re-applied (idempotent `CREATE OR REPLACE`) after
every load:

| view | what |
| --- | --- |
| `v_metric_catalog` | every metric collected: subsystem, pillar, type, sample/series counts, first/last seen |
| `v_scrape_runs` | per-scrape sample counts — gap detection for the exporter itself |
| `v_host_load_latest` | latest load averages + memory / disk utilisation % |
| `v_connection_saturation` | latest connections-in-use vs `max_connections` (% used) |
| `v_cache_hit_hourly` | hourly buffer-cache hit % (block hits vs reads, window deltas) |
| `v_transaction_hourly` | hourly commits / rollbacks, txns/sec, rollback % |
| `v_db_errors_hourly` | hourly deadlocks + conflicts (window deltas) |

The **dbt project** models the same table from the attached Supabase Postgres —
see `dbt/models/staging/stg_supabase_metrics.sql`,
`dbt/models/intermediate/int_supabase_metric_rates.sql`, and the operations
marts `fct_supabase_host_load` / `fct_supabase_db_reliability`.

## Configuration (env)

| var | purpose |
| --- | --- |
| `SUPABASE_POSTGRES_URL` (or `SUPABASE_DB_URL` / `DLT_PG_URL`) | **Required.** Postgres connection string. Use the **session-pooler** URL (IPv4) in CI — see [github_stats/README](../github_stats/README.md#configuration-env). |
| `SUPABASE_METRICS_URL` | Full metrics URL. If unset, derived from `SUPABASE_URL` (`https://<ref>.supabase.co`) + the privileged path. |
| `SUPABASE_METRICS_PASSWORD` | Basic-auth password. Falls back to `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY`. |
| `SUPABASE_METRICS_USERNAME` | Basic-auth username (default `service_role`). |

> **The metrics credential.** The endpoint authenticates with the project's
> service-role credential. If the fallback secret key doesn't authenticate on
> your project, set `SUPABASE_METRICS_PASSWORD` explicitly to the service-role
> JWT from *Project Settings → Data API / API Keys*.

## Run

```bash
cd supabase_stats
# Curated core (default), one snapshot per invocation:
uv run --with "dlt[postgres]" --with requests python pipeline.py

# Capture every series incl. uncurated service metrics:
uv run --with "dlt[postgres]" --with requests python pipeline.py --all
```

`--skip-views` loads the raw table without (re)creating the views. The hourly
schedule runs in [`.github/workflows/supabase-stats.yml`](../.github/workflows/supabase-stats.yml).

## Tests

```bash
cd supabase_stats
uv run --with requests --with pytest python -m pytest -q
```

Hermetic (no network / dlt / Postgres): they cover the Prometheus parser
(labels, escapes, NaN/Inf, histogram-suffix typing), metric classification, and
the client against a fake session.

## Notes

- **dlt state** lives in the destination (`_dlt_*` tables in the
  `supabase_metrics` schema) — nothing is committed, so CI is stateless.
- **Volume:** the curated core is a few hundred series per scrape. Counters are
  cumulative; the views/dbt rate models diff within a window (a counter reset
  shows as a one-window dip — acceptable for monitoring).
- The pipeline raises if the Postgres URL or metrics creds are unset; the
  workflow skips cleanly when the secrets are absent.
