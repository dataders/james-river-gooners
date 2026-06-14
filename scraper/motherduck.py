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
  final_bid decimal(12, 2),
  closed boolean,
  total_bids integer,
  unique_bidders integer,
  category text,
  raw_category text,
  detail_url text,
  images text,
  source_url text,
  ingested_at timestamptz default now(),
  primary key (auction_id, item_id, snapshot_at)
)
"""

# Backfill the column on tables created before unique-bidder support shipped.
ADD_UNIQUE_BIDDERS_SQL = (
    f"alter table {SNAPSHOT_TABLE} add column if not exists unique_bidders integer"
)

# Backfill final-sold-price tracking columns (#94) on pre-existing tables.
ADD_FINAL_BID_SQL = (
    f"alter table {SNAPSHOT_TABLE} add column if not exists final_bid decimal(12, 2)"
)
ADD_CLOSED_SQL = (
    f"alter table {SNAPSHOT_TABLE} add column if not exists closed boolean"
)

INSERT_SNAPSHOT_SQL = f"""
insert or ignore into {SNAPSHOT_TABLE} (
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
  final_bid,
  closed,
  total_bids,
  unique_bidders,
  category,
  raw_category,
  detail_url,
  images,
  source_url
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            # Open lots have no final price yet — keep NULL (not 0.00) so closed
            # vs. still-live can be told apart in the warehouse.
            "final_bid": decimal_text(item.get("finalBid")) if item.get("finalBid") is not None else None,
            "closed": bool(item.get("closed", False)),
            "total_bids": item.get("totalBids", 0),
            "unique_bidders": item.get("uniqueBidders"),
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
        row["final_bid"],
        row["closed"],
        row["total_bids"],
        row["unique_bidders"],
        row["category"],
        row["raw_category"],
        row["detail_url"],
        row["images"],
        row["source_url"],
    )


# Databases whose snapshot DDL has already run this process — the CREATE/ALTER
# statements are idempotent, so running them once per process (not once per
# auction) saves three cloud round-trips per append.
_SCHEMA_READY: set = set()


def _ensure_schema(connection, database: str) -> None:
    if database in _SCHEMA_READY:
        return
    connection.execute(CREATE_TABLE_SQL)
    connection.execute(ADD_UNIQUE_BIDDERS_SQL)
    connection.execute(ADD_FINAL_BID_SQL)
    connection.execute(ADD_CLOSED_SQL)
    _SCHEMA_READY.add(database)


def append_listing_snapshots(items: list[dict], source_url: str, database: str | None = None) -> int:
    import warehouse

    database = warehouse.resolve_database(database)
    warehouse.require_motherduck_token(database, "snapshot listings to MotherDuck")

    rows = rows_for_snapshots(items, source_url)
    if not rows:
        return 0

    values = [row_values(row) for row in rows]

    def _write():
        # Reuse one cloud connection across all auctions in this scrape instead
        # of reconnecting per call (the old per-auction handshake dominated the
        # scrape's runtime, #timeout).
        connection = warehouse.cached_connect(database, "snapshot listings to MotherDuck")
        _ensure_schema(connection, database)
        connection.executemany(INSERT_SNAPSHOT_SQL, values)

    try:
        _write()
    except Exception:  # noqa: BLE001 — a reused connection may have gone stale
        warehouse.reset_cached_connection(database)
        _SCHEMA_READY.discard(database)
        _write()

    return len(rows)
