# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
# ]
# ///
"""
Export PostHog event aggregates → MotherDuck posthog_raw schema.

Creates/replaces three tables:
  posthog_raw.events_daily      — daily counts per event type + unique users
  posthog_raw.search_stats      — daily search breakdowns (semantic vs keyword)
  posthog_raw.toggle_stats      — daily favorite / ignore toggle counts

Requirements:
  POSTHOG_PERSONAL_KEY   — personal API key (phx_...) from posthog.com/settings
  MOTHERDUCK_TOKEN       — read-write MotherDuck PAT

Usage:
  uv run --with requests --with duckdb python3 posthog_export.py
  uv run --with requests --with duckdb python3 posthog_export.py --days 180
"""

import argparse
import env_secrets as secrets
import sys
from datetime import UTC, datetime

try:
    import duckdb
    import requests
except ImportError:
    sys.exit(
        "Install with: uv run --with requests --with duckdb python3 posthog_export.py"
    )

POSTHOG_BASE = "https://us.posthog.com"
PROJECT_ID = 454922


def ph_query(api_key: str, hogql: str) -> list[dict]:
    """Run a HogQL query via the PostHog query API and return rows as dicts."""
    resp = requests.post(
        f"{POSTHOG_BASE}/api/projects/{PROJECT_ID}/query/",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={"query": {"kind": "HogQLQuery", "query": hogql}},
        timeout=60,
    )
    resp.raise_for_status()
    payload = resp.json()
    columns = [col["name"] for col in payload["columns"]]
    return [dict(zip(columns, row, strict=False)) for row in payload["results"]]


def export_events_daily(api_key: str, days: int) -> list[dict]:
    return ph_query(
        api_key,
        f"""
        SELECT
            toDate(timestamp)               AS day,
            event,
            count()                         AS cnt,
            count(DISTINCT distinct_id)     AS distinct_users
        FROM events
        WHERE timestamp >= now() - interval {days} day
          AND event NOT LIKE '$%'
        GROUP BY day, event
        ORDER BY day DESC, cnt DESC
        LIMIT 500
    """,
    )


def export_search_stats(api_key: str, days: int) -> list[dict]:
    return ph_query(
        api_key,
        f"""
        SELECT
            toDate(timestamp)               AS day,
            properties.semantic             AS semantic,
            count()                         AS searches,
            avg(properties.query_length)    AS avg_query_length,
            avg(properties.result_count)    AS avg_result_count
        FROM events
        WHERE event = 'search_performed'
          AND timestamp >= now() - interval {days} day
        GROUP BY day, semantic
        ORDER BY day DESC
        LIMIT 500
    """,
    )


def export_toggle_stats(api_key: str, days: int) -> list[dict]:
    return ph_query(
        api_key,
        f"""
        SELECT
            toDate(timestamp)               AS day,
            event,
            properties.adding               AS adding,
            properties.signed_in            AS signed_in,
            count()                         AS cnt,
            count(DISTINCT distinct_id)     AS distinct_users
        FROM events
        WHERE event IN ('favorite_toggled', 'ignored_toggled')
          AND timestamp >= now() - interval {days} day
        GROUP BY day, event, adding, signed_in
        ORDER BY day DESC
        LIMIT 500
    """,
    )


def load_to_motherduck(
    rows: list[dict], schema: str, table: str, motherduck_token: str
) -> None:
    if not rows:
        print(f"  {schema}.{table}: no rows to load")
        return

    con = duckdb.connect(f"md:my_db?motherduck_token={motherduck_token}")
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
    # Infer columns from first row
    cols = list(rows[0].keys())
    placeholders = ", ".join(["?" for _ in cols])
    col_list = ", ".join(cols)

    con.execute(f"DROP TABLE IF EXISTS {schema}.{table}")
    # Build CREATE from first row types (DuckDB will infer)
    values = [[row[c] for c in cols] for row in rows]
    con.executemany(
        f"INSERT INTO {schema}.{table} ({col_list}) VALUES ({placeholders})",
        values,
    ) if False else None  # skip — use register+CREATE AS SELECT instead

    import pandas as pd  # noqa: PLC0415 — optional, keeps top-level imports minimal

    df = pd.DataFrame(rows)
    con.register("_tmp", df)
    con.execute(f"CREATE OR REPLACE TABLE {schema}.{table} AS SELECT * FROM _tmp")
    con.close()

    print(f"  {schema}.{table}: {len(rows)} rows loaded")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=90)
    args = parser.parse_args()

    api_key = secrets.posthog_personal_key()
    if not api_key:
        sys.exit(
            "Set POSTHOG_PERSONAL_KEY to your phx_... personal API key from posthog.com/settings"
        )
    motherduck_token = secrets.motherduck_token()
    if not motherduck_token:
        sys.exit("Set MOTHERDUCK_TOKEN")

    print(f"Querying PostHog (last {args.days} days)…")
    events_daily = export_events_daily(api_key, args.days)
    search_stats = export_search_stats(api_key, args.days)
    toggle_stats = export_toggle_stats(api_key, args.days)

    print(f"  events_daily: {len(events_daily)} rows")
    print(f"  search_stats: {len(search_stats)} rows")
    print(f"  toggle_stats: {len(toggle_stats)} rows")

    print("Loading into MotherDuck posthog_raw…")
    load_to_motherduck(events_daily, "posthog_raw", "events_daily", motherduck_token)
    load_to_motherduck(search_stats, "posthog_raw", "search_stats", motherduck_token)
    load_to_motherduck(toggle_stats, "posthog_raw", "toggle_stats", motherduck_token)

    print(f"Done. Exported as of {datetime.now(UTC).isoformat()}")


if __name__ == "__main__":
    main()
