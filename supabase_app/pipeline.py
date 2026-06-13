"""Supabase app tables → MotherDuck, via dlt.

Copies the RLS-public application tables (lots, sold_lots, lot_enrichment, the
eBay/Cannon's comp snapshots, favorites, ignored, users) from Supabase Postgres
into MotherDuck (``md:my_db``, schema ``supabase_app``) so the dbt analytics
project reads them **natively from the warehouse** — no live Postgres attach
during ``dbt build``.

Why this exists: the resale/product/operations marts used to read these tables
through a live read-only Postgres ATTACH, so every ``dbt build`` pulled them
across the wire from the shared (small) Supabase instance the app itself serves
from. Mirroring ``github_stats/``, we snapshot the raw tables into MotherDuck
once per refresh; dbt then transforms them in the same database with no
cross-database hop, keeping build-time read load off the live app database.

Full-refresh (``write_disposition="replace"``) per run: the marts only need the
current state, and these tables are modest, so a clean snapshot each refresh is
simpler than cursor-based incrementals (and avoids stale rows after deletes).

Config (env):
- ``MOTHERDUCK_TOKEN`` — read/write MotherDuck PAT (destination). The
  read-scaling ``MOTHERDUCK_READ_TOKEN`` can't write and is not used.
- ``SUPABASE_POSTGRES_URL_IP4`` (preferred) or ``SUPABASE_POSTGRES_URL`` — the
  Postgres source URL. Use the **IPv4 session-pooler** URL in CI (GitHub runners
  have no IPv6; the direct ``db.<ref>.supabase.co`` host is IPv6-only).

Run (see .github/workflows/admin-dashboard.yml):
    uv run --with "dlt[motherduck,sql_database]" --with psycopg2-binary \
        python pipeline.py
"""

from __future__ import annotations

import argparse
import os
import sys

# dlt (+ its sql_database extra) is imported lazily inside run() so the module's
# pure helpers + table list stay importable for the unit tests without the heavy
# dependency.

MD_DATABASE = "my_db"
APP_DATASET = "supabase_app"
PIPELINE_NAME = "supabase_app"

# The RLS-public app tables the dbt `gooners` source reads. (Embeddings,
# enrichment-extra, and credential tables are intentionally excluded — the
# marts don't read them.)
APP_TABLES = [
    "lots",
    "sold_lots",
    "lot_enrichment",
    "ebay_comp_snapshots",
    "cannons_comp_snapshots",
    "favorites",
    "ignored",
    "users",
]


def _motherduck_credentials() -> str | None:
    token = os.environ.get("MOTHERDUCK_TOKEN")
    return f"md:{MD_DATABASE}?motherduck_token={token}" if token else None


def _postgres_url() -> str | None:
    # Prefer the IPv4 session-pooler URL (works on GitHub runners / IPv4-only
    # sandboxes); fall back to whatever SUPABASE_POSTGRES_URL is set to.
    return os.environ.get("SUPABASE_POSTGRES_URL_IP4") or os.environ.get("SUPABASE_POSTGRES_URL")


def run(tables: list[str] | None = None):
    creds = _motherduck_credentials()
    if not creds:
        raise RuntimeError(
            "Set MOTHERDUCK_TOKEN (a read/write MotherDuck PAT) to load the "
            f"Supabase app tables into MotherDuck ({MD_DATABASE}.{APP_DATASET})."
        )
    pg_url = _postgres_url()
    if not pg_url:
        raise RuntimeError(
            "Set SUPABASE_POSTGRES_URL_IP4 (or SUPABASE_POSTGRES_URL) — the IPv4 "
            "session-pooler Postgres URL — to read the source tables."
        )

    import dlt
    from dlt.sources.sql_database import sql_database

    tables = tables or APP_TABLES
    print(f"Copying public.{{{', '.join(tables)}}} → MotherDuck {MD_DATABASE}.{APP_DATASET}")

    source = sql_database(
        credentials=pg_url,
        schema="public",
        table_names=tables,
        # Reflect each table fresh; don't carry a stale cached schema.
        reflection_level="full",
    )

    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.motherduck(credentials=creds),
        dataset_name=APP_DATASET,
    )
    info = pipeline.run(source, write_disposition="replace")
    print(info)
    return info


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy Supabase app tables into MotherDuck via dlt")
    parser.add_argument(
        "--tables",
        nargs="*",
        default=None,
        help=f"Subset of tables to copy (default: all — {', '.join(APP_TABLES)})",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    run(tables=args.tables)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
