# /// script
# requires-python = ">=3.11"
# dependencies = []  # duckdb stays a --with flag (heavy): --with 'duckdb==1.5.2'
# ///
"""Capture analytics-pipeline run metrics into MotherDuck (my_db.meta).

The dlt copy + dbt build produce rich per-run detail every time — rows loaded,
each model's status/rows/runtime, every test pass/fail — but it's printed to logs
and then thrown away (dbt's `target/` is ephemeral on the runner). This records
it so it can be monitored over time:

  - meta.dbt_run_results — one row per node per invocation from
    dbt/target/run_results.json (resource_type, status, rows_affected,
    execution_time, message). Covers dbt test pass/fail + model build health.
  - meta.source_row_counts — a per-run snapshot of row counts for the
    warehouse-native source tables (supabase_app.*, github_stats.*,
    posthog_raw.*), so "rows processed" trends are queryable.

The admin dashboard's "Pipeline health" tab reads these.

Config: MOTHERDUCK_TOKEN (a read/write MotherDuck PAT).

Usage (see .github/workflows/admin-dashboard.yml):
    uv run --with 'duckdb==1.5.2' python capture.py --target-dir ../dbt/target
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

MD_DATABASE = "my_db"
META_SCHEMA = "meta"
# Warehouse-native source schemas to snapshot row counts for.
SOURCE_SCHEMAS = ["supabase_app", "github_stats", "posthog_raw", "supabase_metrics"]


def parse_run_results(doc: dict) -> list[dict]:
    """Flatten dbt's run_results.json into one dict per node."""
    meta = doc.get("metadata", {})
    invocation_id = meta.get("invocation_id")
    generated_at = meta.get("generated_at")
    out = []
    for r in doc.get("results", []):
        node = r.get("unique_id") or ""
        adapter = r.get("adapter_response") or {}
        rows_affected = adapter.get("rows_affected")
        out.append(
            {
                "invocation_id": invocation_id,
                "generated_at": generated_at,
                "node": node,
                # unique_id is like "model.<project>.<name>" / "test.<project>.<name>"
                "resource_type": node.split(".", 1)[0] if node else None,
                "name": node.rsplit(".", 1)[-1] if node else None,
                "status": r.get("status"),
                "rows_affected": int(rows_affected) if isinstance(rows_affected, (int, float)) else None,
                "execution_time": r.get("execution_time"),
                "message": (r.get("message") or "")[:500],
            }
        )
    return out


def _connect():
    token = os.environ.get("MOTHERDUCK_TOKEN")
    if not token:
        sys.exit("MOTHERDUCK_TOKEN (a read/write MotherDuck PAT) is required.")
    import duckdb

    return duckdb.connect(f"md:{MD_DATABASE}?motherduck_token={token}")


def write_dbt_run_results(con, rows: list[dict], captured_at: dt.datetime) -> int:
    con.execute(f"create schema if not exists {META_SCHEMA}")
    con.execute(
        f"""
        create table if not exists {META_SCHEMA}.dbt_run_results (
            captured_at timestamptz, invocation_id varchar, generated_at varchar,
            node varchar, resource_type varchar, name varchar, status varchar,
            rows_affected bigint, execution_time double, message varchar
        )
        """
    )
    con.executemany(
        f"insert into {META_SCHEMA}.dbt_run_results values (?,?,?,?,?,?,?,?,?,?)",
        [
            (
                captured_at, r["invocation_id"], r["generated_at"], r["node"],
                r["resource_type"], r["name"], r["status"], r["rows_affected"],
                r["execution_time"], r["message"],
            )
            for r in rows
        ],
    )
    return len(rows)


def snapshot_source_row_counts(con, captured_at: dt.datetime) -> int:
    con.execute(f"create schema if not exists {META_SCHEMA}")
    con.execute(
        f"""
        create table if not exists {META_SCHEMA}.source_row_counts (
            captured_at timestamptz, schema_name varchar, table_name varchar, row_count bigint
        )
        """
    )
    placeholders = ",".join("?" for _ in SOURCE_SCHEMAS)
    tables = con.execute(
        f"""
        select table_schema, table_name
        from information_schema.tables
        where table_catalog = '{MD_DATABASE}'
          and table_schema in ({placeholders})
          and table_name not like '\\_dlt%' escape '\\'
        order by 1, 2
        """,
        SOURCE_SCHEMAS,
    ).fetchall()

    recorded = 0
    for schema, table in tables:
        try:
            n = con.execute(f'select count(*) from "{schema}"."{table}"').fetchone()[0]
        except Exception as exc:  # noqa: BLE001 — skip an unreadable table, keep going
            print(f"  [warn] count {schema}.{table} failed: {str(exc)[:80]}", file=sys.stderr)
            continue
        con.execute(
            f"insert into {META_SCHEMA}.source_row_counts values (?,?,?,?)",
            [captured_at, schema, table, n],
        )
        recorded += 1
    return recorded


def run(target_dir: str):
    captured_at = dt.datetime.now(dt.UTC)
    con = _connect()
    try:
        run_results_path = os.path.join(target_dir, "run_results.json")
        if os.path.exists(run_results_path):
            with open(run_results_path, encoding="utf-8") as fh:
                rows = parse_run_results(json.load(fh))
            n = write_dbt_run_results(con, rows, captured_at)
            print(f"Recorded {n} dbt node results → {META_SCHEMA}.dbt_run_results")
        else:
            print(f"No run_results.json at {run_results_path} — skipping dbt capture.")

        n = snapshot_source_row_counts(con, captured_at)
        print(f"Snapshotted {n} source table row counts → {META_SCHEMA}.source_row_counts")
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture dbt + dlt pipeline metrics into MotherDuck meta schema")
    parser.add_argument("--target-dir", default="../dbt/target", help="dbt target dir holding run_results.json")
    args = parser.parse_args(argv if argv is not None else sys.argv[1:])
    run(args.target_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
