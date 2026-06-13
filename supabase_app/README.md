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

## How it reads — PostgREST (HTTPS), not Postgres :5432

The copy reads each table through Supabase's **PostgREST** API over HTTPS, paging
with `Range` headers and following the `Content-Range` total. The service key
bypasses RLS to read every row. This uses the secrets the project already has
(`SUPABASE_URL` + `SUPABASE_SECRET_KEY`) — no separate Postgres connection
string / session-pooler URL — and works anywhere HTTPS does (CI, IPv4-only or
HTTPS-only sandboxes), sidestepping the IPv6/pooler quirks of a direct Postgres
connection.

## Configuration (env)

| var | purpose |
| --- | --- |
| `MOTHERDUCK_TOKEN` | **Required.** Read/write MotherDuck PAT (destination). |
| `SUPABASE_URL` | **Required.** Project URL (`https://<ref>.supabase.co`); REST base is `<url>/rest/v1`. |
| `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | **Required.** Service key — reads all rows (bypasses RLS). Backend-only; never in a `VITE_` var or the bundle. |

## Run

```bash
cd supabase_app
uv run --with "dlt[motherduck]" --with requests python pipeline.py
# subset:
uv run --with "dlt[motherduck]" --with requests python pipeline.py --tables lots users
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
