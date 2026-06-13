# Supabase app tables → MotherDuck (dlt)

A [dlt](https://dlthub.com) pipeline that snapshots the RLS-public Supabase
**application tables** into **MotherDuck** (`md:my_db`, schema `supabase_app`),
so the dbt analytics project reads them natively from the warehouse — the
sibling of [`github_stats/`](../github_stats) for the app's own Postgres data.

## Why

The resale / product / operations marts read these tables. They used to read
them through a live read-only **Postgres ATTACH** in `dbt/profiles.yml`, so every
`dbt build` pulled them across the wire from the shared (small) Supabase instance
the app itself serves from. This pipeline copies them into MotherDuck once per
refresh; dbt then transforms them in the same database with **no Postgres attach**
(see `dbt/models/staging/_sources.yml` — the `gooners` source now points at
`schema: supabase_app`), keeping build-time read load off the live app database
and removing the IPv4/IPv6 pooler quirks from the build.

## What it copies

Full-refresh (`write_disposition="replace"`) each run — the marts need current
state, the tables are modest, and a clean snapshot avoids stale rows after
deletes:

`lots`, `sold_lots`, `lot_enrichment`, `ebay_comp_snapshots`,
`cannons_comp_snapshots`, `favorites`, `ignored`, `users` → `my_db.supabase_app.*`

> Supabase **platform metrics** (`supabase_metrics`) are a separate dataset
> loaded by [`supabase_stats/`](../supabase_stats); point that pipeline at
> MotherDuck too and the `supabase_metrics` dbt source resolves natively there.

## Configuration (env)

| var | purpose |
| --- | --- |
| `MOTHERDUCK_TOKEN` | **Required.** Read/write MotherDuck PAT (destination). |
| `SUPABASE_POSTGRES_URL_IP4` (preferred) / `SUPABASE_POSTGRES_URL` | **Required.** Postgres source URL. Use the **IPv4 session-pooler** URL in CI — GitHub runners have no IPv6, and the direct `db.<ref>.supabase.co` host is IPv6-only. (Reached on port 5432, so this needs Postgres egress — it runs in GitHub Actions, not in HTTPS-only sandboxes.) |

## Run

```bash
cd supabase_app
uv run --with "dlt[motherduck,sql_database]" --with psycopg2-binary python pipeline.py
# subset:
uv run --with "dlt[motherduck,sql_database]" --with psycopg2-binary python pipeline.py --tables lots users
```

Runs hourly as step 1 of [`.github/workflows/admin-dashboard.yml`](../.github/workflows/admin-dashboard.yml)
(copy → dbt build → render → upload).

## Tests

```bash
cd supabase_app
uv run --with pytest python -m pytest -q
```

Hermetic (no network / dlt): dlt is imported lazily inside `run()`, so the env
resolution, the table list, and arg parsing are covered in isolation.
