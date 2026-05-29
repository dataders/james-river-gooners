import json
import os
from decimal import Decimal, InvalidOperation
from datetime import datetime, timezone

from dates import parse_auction_datetime


SNAPSHOT_TABLE = "listing_snapshots"

CREATE_TABLE_SQL = f"""
create table if not exists {SNAPSHOT_TABLE} (
  auction_id text,
  auction_safe_id text,
  item_id text,
  lot_number bigint,
  snapshot_at timestamptz,
  auction_title text,
  auction_end_at timestamptz,
  item_end_at timestamptz,
  title text,
  description text,
  current_bid decimal(12, 2),
  total_bids integer,
  category text,
  raw_category text,
  detail_url text,
  images text,
  source_url text,
  ingested_at timestamptz default now(),
  primary key (auction_id, item_id, snapshot_at)
)
"""

INSERT_SNAPSHOT_SQL = f"""
insert into {SNAPSHOT_TABLE} (
  auction_id,
  auction_safe_id,
  item_id,
  lot_number,
  snapshot_at,
  auction_title,
  auction_end_at,
  item_end_at,
  title,
  description,
  current_bid,
  total_bids,
  category,
  raw_category,
  detail_url,
  images,
  source_url
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def should_snapshot_to_motherduck() -> bool:
    flag = os.environ.get("GOONERS_MOTHERDUCK_SNAPSHOTS", "")
    return flag.lower() in {"1", "true", "yes", "on"}


def decimal_text(value) -> str:
    try:
        amount = Decimal(str(value or 0))
    except (InvalidOperation, ValueError):
        amount = Decimal("0")
    return f"{amount:.2f}"


def images_text(value) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return "[]"
    return json.dumps(value)


def timestamp_value(value):
    return parse_auction_datetime(value)


def rows_for_snapshots(items: list[dict], source_url: str) -> list[dict]:
    snapshot_at = datetime.now(timezone.utc)
    rows = []

    for item in items:
        rows.append({
            "auction_id": item.get("auctionId", ""),
            "auction_safe_id": item.get("auctionSafeId", ""),
            "item_id": item.get("id", ""),
            "lot_number": item.get("lotNumber", 0),
            "snapshot_at": timestamp_value(item.get("scrapedAt")) or snapshot_at,
            "auction_title": item.get("auctionTitle", ""),
            "auction_end_at": timestamp_value(item.get("auctionEndDate")),
            "item_end_at": timestamp_value(item.get("endDate")),
            "title": item.get("title", ""),
            "description": item.get("description", ""),
            "current_bid": decimal_text(item.get("currentBid")),
            "total_bids": item.get("totalBids", 0),
            "category": item.get("category", ""),
            "raw_category": item.get("rawCategory", ""),
            "detail_url": item.get("detailUrl", ""),
            "images": images_text(item.get("images")),
            "source_url": source_url,
        })

    return rows


def row_values(row: dict) -> tuple:
    return (
        row["auction_id"],
        row["auction_safe_id"],
        row["item_id"],
        row["lot_number"],
        row["snapshot_at"],
        row["auction_title"],
        row["auction_end_at"],
        row["item_end_at"],
        row["title"],
        row["description"],
        row["current_bid"],
        row["total_bids"],
        row["category"],
        row["raw_category"],
        row["detail_url"],
        row["images"],
        row["source_url"],
    )


def append_listing_snapshots(items: list[dict], source_url: str, database: str | None = None) -> int:
    if not os.environ.get("MOTHERDUCK_TOKEN"):
        raise RuntimeError("MOTHERDUCK_TOKEN is required when MotherDuck snapshots are enabled")

    rows = rows_for_snapshots(items, source_url)
    if not rows:
        return 0

    import duckdb

    database = database or os.environ.get("MOTHERDUCK_DATABASE", "md:")
    connection = duckdb.connect(database)
    try:
        connection.execute(CREATE_TABLE_SQL)
        connection.executemany(INSERT_SNAPSHOT_SQL, [row_values(row) for row in rows])
    finally:
        connection.close()

    return len(rows)
