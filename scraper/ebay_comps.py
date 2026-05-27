#!/usr/bin/env python
"""
Export eBay sold-comps from MotherDuck into the static GitHub Pages read model.

The scraper/write side can populate either:
- public_auction_comps: a public read model view/table with one row per match
- ebay_comp_snapshots: an append-only raw table with compatible columns

This command is read-only from MotherDuck's perspective, so it can run with a
read-scaling token.
"""

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlparse


DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
EBAY_COMPS_DIR = DATA_DIR / "ebay-comps"
PUBLIC_VIEW = "public_auction_comps"
SNAPSHOT_TABLE = "ebay_comp_snapshots"

EXPORT_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "status",
    "query",
    "search_url",
    "fetched_at",
    "warning",
    "ebay_item_id",
    "title",
    "price_value",
    "price_currency",
    "shipping_label",
    "sold_date",
    "sold_date_label",
    "thumbnail_url",
    "item_web_url",
    "condition",
    "source_query",
    "match_confidence",
)


def utc_now_text() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def json_value(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return f"{value:.2f}"
    return value


def text_value(value, default: str = "") -> str:
    if value is None:
        return default
    return str(json_value(value))


def is_ebay_item_url(value: str) -> bool:
    if not value:
        return False

    try:
        parsed = urlparse(value)
    except ValueError:
        return False

    hostname = parsed.hostname or ""
    if hostname != "ebay.com" and not hostname.endswith(".ebay.com"):
        return False

    segments = [segment for segment in parsed.path.split("/") if segment]
    if "itm" not in segments:
        return False

    item_index = segments.index("itm")
    return any(segment.isdigit() and len(segment) >= 9 for segment in segments[item_index + 1:])


def normalize_match_row(row: dict) -> tuple[str, str, dict] | None:
    item_web_url = text_value(row.get("item_web_url"))
    title = text_value(row.get("title"))
    price_value = text_value(row.get("price_value"))

    if not title or not price_value or not is_ebay_item_url(item_web_url):
        return None

    auction_safe_id = text_value(row.get("auction_safe_id"))
    item_id = text_value(row.get("item_id"))
    if not auction_safe_id or not item_id:
        return None

    match = {
        "ebayItemId": text_value(row.get("ebay_item_id")) or None,
        "title": title,
        "price": {
            "value": price_value,
            "currency": text_value(row.get("price_currency"), "USD"),
        },
        "shippingLabel": text_value(row.get("shipping_label")) or None,
        "soldDate": text_value(row.get("sold_date")) or None,
        "soldDateLabel": text_value(row.get("sold_date_label")) or None,
        "thumbnailUrl": text_value(row.get("thumbnail_url")) or None,
        "itemWebUrl": item_web_url,
        "condition": text_value(row.get("condition")) or None,
        "sourceQuery": text_value(row.get("source_query")) or None,
        "matchConfidence": text_value(row.get("match_confidence")) or None,
    }
    return auction_safe_id, item_id, {k: v for k, v in match.items() if v is not None}


def build_public_exports(rows: list[dict], generated_at: str | None = None) -> dict[str, dict]:
    generated_at = generated_at or utc_now_text()
    exports: dict[str, dict] = {}

    for row in rows:
        normalized = normalize_match_row(row)
        if normalized is None:
            continue

        auction_safe_id, item_id, match = normalized
        auction_export = exports.setdefault(auction_safe_id, {
            "schemaVersion": 1,
            "generatedAt": generated_at,
            "marketplaceId": "EBAY_US",
            "source": "motherduck",
            "items": {},
        })
        item_export = auction_export["items"].setdefault(item_id, {
            "status": text_value(row.get("status"), "ok"),
            "query": text_value(row.get("query")),
            "searchUrl": text_value(row.get("search_url")),
            "fetchedAt": text_value(row.get("fetched_at")) or generated_at,
            "warning": text_value(row.get("warning")) or None,
            "matches": [],
        })
        item_export["matches"].append(match)

    return exports


def write_public_exports(exports: dict[str, dict], output_dir: Path = EBAY_COMPS_DIR) -> int:
    if not exports:
        return 0

    output_dir.mkdir(parents=True, exist_ok=True)
    for stale_path in output_dir.glob("*.json"):
        stale_path.unlink()

    for auction_safe_id, payload in sorted(exports.items()):
        path = output_dir / f"{auction_safe_id}.json"
        path.write_text(json.dumps(payload, indent=2) + "\n")

    return len(exports)


def row_dicts(cursor) -> list[dict]:
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def query_source_table(connection, table_name: str) -> list[dict]:
    column_sql = ", ".join(EXPORT_COLUMNS)
    query = f"""
        select {column_sql}
        from {table_name}
        where item_web_url is not null
        order by auction_safe_id, item_id, sold_date desc nulls last, title
    """
    return row_dicts(connection.execute(query))


def table_exists(connection, table_name: str) -> bool:
    rows = connection.execute(
        """
        select 1
        from information_schema.tables
        where table_name = ?
        limit 1
        """,
        [table_name],
    ).fetchall()
    return bool(rows)


def export_from_motherduck(
    database: str | None = None,
    output_dir: Path = EBAY_COMPS_DIR,
    allow_missing: bool = False,
) -> int:
    if not os.environ.get("MOTHERDUCK_TOKEN"):
        raise RuntimeError("MOTHERDUCK_TOKEN is required to export eBay comps from MotherDuck")

    import duckdb

    connection = duckdb.connect(database or os.environ.get("MOTHERDUCK_DATABASE", "md:"))
    try:
        source_table = None
        for candidate in (PUBLIC_VIEW, SNAPSHOT_TABLE):
            if table_exists(connection, candidate):
                source_table = candidate
                break

        if source_table is None:
            if allow_missing:
                print(f"No {PUBLIC_VIEW} or {SNAPSHOT_TABLE} table found; leaving existing eBay comp files unchanged")
                return 0
            raise RuntimeError(f"No {PUBLIC_VIEW} or {SNAPSHOT_TABLE} table found in MotherDuck")

        rows = query_source_table(connection, source_table)
    finally:
        connection.close()

    exports = build_public_exports(rows)
    written = write_public_exports(exports, output_dir)
    print(f"Exported {written} auction eBay comp files from {source_table}")
    return written


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export eBay comps from MotherDuck")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Export static eBay comp JSON from MotherDuck")
    export_parser.add_argument("--database", default=None, help="DuckDB/MotherDuck database string")
    export_parser.add_argument("--output-dir", type=Path, default=EBAY_COMPS_DIR)
    export_parser.add_argument(
        "--allow-missing",
        action="store_true",
        help="Exit successfully when the MotherDuck comp table/view does not exist yet",
    )

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    if args.command == "export":
        export_from_motherduck(
            database=args.database,
            output_dir=args.output_dir,
            allow_missing=args.allow_missing,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
