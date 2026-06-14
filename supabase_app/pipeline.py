# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "dlt[motherduck]",
#     "requests",
# ]
# ///
"""Supabase app tables → MotherDuck, via dlt (PostgREST source).

Copies the RLS-public application tables (lots, sold_lots, lot_enrichment, the
eBay/Cannon's comp snapshots, favorites, ignored, users) from Supabase into
MotherDuck (``md:my_db``, schema ``supabase_app``), so the dbt analytics project
reads them **natively from the warehouse** — the sibling of ``github_stats/`` for
the app's own data.

Why this exists: the resale/product/operations marts used to read these tables
through a live read-only Postgres ATTACH, so every ``dbt build`` pulled them
across the wire from the shared (small) Supabase instance the app itself serves
from. Mirroring ``github_stats/``, we snapshot the raw tables into MotherDuck
once per refresh; dbt then transforms them in the same database with no
cross-database hop, keeping build-time read load off the live app database.

**Reads over PostgREST (HTTPS), not Postgres :5432.** The service key bypasses
RLS to read every row, and HTTPS works everywhere (CI, IPv4-only/HTTPS-only
sandboxes) using the ``SUPABASE_URL`` + ``SUPABASE_SECRET_KEY`` secrets the
project already has — no separate Postgres connection string / pooler URL.

Full-refresh (``write_disposition="replace"``) per run: the marts only need the
current state, the tables are modest, and a clean snapshot avoids stale rows.

Config (env):
- ``MOTHERDUCK_TOKEN`` — read/write MotherDuck PAT (destination). The
  read-scaling ``MOTHERDUCK_READ_TOKEN`` can't write and is not used.
- ``SUPABASE_URL`` — project URL (``https://<ref>.supabase.co``); the REST base
  is ``<url>/rest/v1``.
- ``SUPABASE_SECRET_KEY`` (or ``SUPABASE_SERVICE_ROLE_KEY``) — service key; reads
  all rows (bypasses RLS). Backend-only — never in a VITE_ var or the bundle.

Run (see .github/workflows/admin-dashboard.yml):
    uv run --with "dlt[motherduck]" --with requests python pipeline.py
"""

from __future__ import annotations

import argparse
import os
import sys

import requests

# dlt (+ the motherduck extra) is imported lazily inside run() so the module's
# pure helpers + table list stay importable for the unit tests without it.

MD_DATABASE = "my_db"
APP_DATASET = "supabase_app"
PIPELINE_NAME = "supabase_app"

# PostgREST caps rows per response (Supabase default db-max-rows = 1000); we page
# with Range headers and follow the Content-Range total, so this is just the
# request size, robust to a lower server cap.
PAGE_SIZE = 1000

# The RLS-public app tables the dbt `gooners` source reads. (Embeddings,
# credential, and enrichment-extra tables are intentionally excluded — the
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

# PostgREST serialises every value as JSON, which loses some Postgres types that
# the dbt staging models rely on. These hints pin them so the copy is faithful:
#   - users.cannon_bidder_id is often entirely NULL (few linked accounts); dlt
#     would drop an all-null column, but stg_users selects it.
#   - lots.images is a Postgres array → a JSON array over REST; without a hint
#     dlt spins it into a child table. Pin it as a single json column (stg_lots
#     reads its length via json_array_length).
# (Date-only columns like ebay_comp_snapshots.sold_date stay text — dlt only
# auto-types full timestamps — so the staging models cast them with ::date.)
COLUMN_HINTS: dict[str, dict] = {
    "users": {"cannon_bidder_id": {"data_type": "text"}},
    "lots": {"images": {"data_type": "json"}},
}


def _motherduck_credentials() -> str | None:
    token = os.environ.get("MOTHERDUCK_TOKEN")
    return f"md:{MD_DATABASE}?motherduck_token={token}" if token else None


def _rest_config() -> tuple[str, str] | None:
    """Return (rest_base_url, service_key) or None if unconfigured."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    return f"{url.rstrip('/')}/rest/v1", key


def iter_rows(base: str, key: str, table: str, page_size: int = PAGE_SIZE, session=None):
    """Yield every row of a table via paginated PostgREST GETs (service key)."""
    sess = session or requests.Session()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        # count=exact makes PostgREST return the total in Content-Range, so we
        # can page deterministically even if the server caps below page_size.
        "Prefer": "count=exact",
    }
    offset = 0
    while True:
        resp = sess.get(
            f"{base}/{table}",
            headers={**headers, "Range-Unit": "items", "Range": f"{offset}-{offset + page_size - 1}"},
            params={"select": "*"},
            timeout=60,
        )
        resp.raise_for_status()
        rows = resp.json()
        yield from rows

        # Content-Range: "<start>-<end>/<total>" (total is "*" without count).
        total = None
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            tail = content_range.rsplit("/", 1)[-1]
            total = int(tail) if tail.isdigit() else None

        offset += len(rows)
        if not rows:
            break
        if total is not None and offset >= total:
            break
        if total is None and len(rows) < page_size:
            break


def run(tables: list[str] | None = None):
    creds = _motherduck_credentials()
    if not creds:
        raise RuntimeError(
            "Set MOTHERDUCK_TOKEN (a read/write MotherDuck PAT) to load the "
            f"Supabase app tables into MotherDuck ({MD_DATABASE}.{APP_DATASET})."
        )
    rest = _rest_config()
    if not rest:
        raise RuntimeError(
            "Set SUPABASE_URL and SUPABASE_SECRET_KEY to read the app tables over "
            "PostgREST (the service key bypasses RLS to read every row)."
        )
    base, key = rest

    import dlt

    tables = tables or APP_TABLES
    print(f"Copying {len(tables)} Supabase tables → MotherDuck {MD_DATABASE}.{APP_DATASET} (via PostgREST)")

    @dlt.source(name="supabase_app")
    def source():
        for table in tables:
            yield dlt.resource(
                iter_rows(base, key, table),
                name=table,
                write_disposition="replace",
                columns=COLUMN_HINTS.get(table),
            )

    pipeline = dlt.pipeline(
        pipeline_name=PIPELINE_NAME,
        destination=dlt.destinations.motherduck(credentials=creds),
        dataset_name=APP_DATASET,
    )
    info = pipeline.run(source())
    print(info)
    return info


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Copy Supabase app tables into MotherDuck via dlt (PostgREST)")
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
