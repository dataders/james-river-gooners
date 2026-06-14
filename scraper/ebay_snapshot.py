"""eBay comp snapshot row building and MotherDuck DDL.

Owns the warehouse write contract: how comp rows are shaped for the
``ebay_comp_snapshots`` table and inserted into a DuckDB/MotherDuck connection.
"""

import json
from datetime import UTC, datetime

from ebay_util import decimal_text, text_value

SNAPSHOT_TABLE = "ebay_comp_snapshots"
PUBLIC_VIEW = "public_auction_comps"

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

CREATE_COMP_TABLE_SQL = f"""
create table if not exists {SNAPSHOT_TABLE} (
  auction_safe_id text,
  item_id text,
  status text,
  query text,
  search_url text,
  fetched_at timestamptz,
  warning text,
  ebay_item_id text,
  title text,
  price_value decimal(12, 2),
  price_currency text,
  shipping_label text,
  sold_date date,
  sold_date_label text,
  thumbnail_url text,
  item_web_url text,
  condition text,
  source_query text,
  match_confidence text,
  auction_id text,
  lot_number bigint,
  cannons_title text,
  cannons_description text,
  current_bid decimal(12, 2),
  total_bids integer,
  detail_url text,
  raw_match_json text,
  ingested_at timestamptz default now()
)
"""

PUBLIC_VIEW_SQL = f"""
create or replace view {PUBLIC_VIEW} as
select {", ".join(EXPORT_COLUMNS)}
from (
  select
    {", ".join(EXPORT_COLUMNS)},
    dense_rank() over (
      partition by auction_safe_id, item_id, source_query
      order by fetched_at desc
    ) as fetch_rank
  from {SNAPSHOT_TABLE}
  where item_web_url is not null
)
where fetch_rank = 1
"""

INSERT_COMP_SQL = f"""
insert into {SNAPSHOT_TABLE} (
  auction_safe_id,
  item_id,
  status,
  query,
  search_url,
  fetched_at,
  warning,
  ebay_item_id,
  title,
  price_value,
  price_currency,
  shipping_label,
  sold_date,
  sold_date_label,
  thumbnail_url,
  item_web_url,
  condition,
  source_query,
  match_confidence,
  auction_id,
  lot_number,
  cannons_title,
  cannons_description,
  current_bid,
  total_bids,
  detail_url,
  raw_match_json
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def comp_rows_for_item(
    item: dict,
    search: dict,
    matches: list[dict],
    status: str,
    fetched_at: str | datetime | None = None,
    warning: str | None = None,
) -> list[dict]:
    fetched_at = fetched_at or datetime.now(UTC)
    base = {
        "auction_safe_id": text_value(item.get("auctionSafeId")),
        "item_id": text_value(item.get("id")),
        "status": status,
        "query": text_value(search.get("query")),
        "search_url": text_value(search.get("url")),
        "fetched_at": fetched_at,
        "warning": warning or search.get("warning") or None,
        "auction_id": text_value(item.get("auctionId")),
        "lot_number": item.get("lotNumber") or 0,
        "cannons_title": text_value(item.get("title")),
        "cannons_description": text_value(item.get("description")),
        "current_bid": decimal_text(item.get("currentBid")),
        "total_bids": item.get("totalBids") or 0,
        "detail_url": text_value(item.get("detailUrl")),
    }

    if not matches:
        return [{
            **base,
            "ebay_item_id": None,
            "title": None,
            "price_value": None,
            "price_currency": None,
            "shipping_label": None,
            "sold_date": None,
            "sold_date_label": None,
            "thumbnail_url": None,
            "item_web_url": None,
            "condition": None,
            "source_query": search.get("kind"),
            "match_confidence": None,
            "raw_match_json": None,
        }]

    rows = []
    for match in matches:
        rows.append({
            **base,
            "status": "ok",
            "ebay_item_id": match.get("ebay_item_id"),
            "title": match.get("title"),
            "price_value": match.get("price_value"),
            "price_currency": match.get("price_currency") or "USD",
            "shipping_label": match.get("shipping_label"),
            "sold_date": match.get("sold_date"),
            "sold_date_label": match.get("sold_date_label"),
            "thumbnail_url": match.get("thumbnail_url"),
            "item_web_url": match.get("item_web_url"),
            "condition": match.get("condition"),
            "source_query": match.get("source_query") or search.get("kind"),
            "match_confidence": match.get("match_confidence") or "medium",
            "raw_match_json": json.dumps(match, sort_keys=True),
        })
    return rows


def comp_row_values(row: dict) -> tuple:
    return (
        row.get("auction_safe_id"),
        row.get("item_id"),
        row.get("status"),
        row.get("query"),
        row.get("search_url"),
        row.get("fetched_at"),
        row.get("warning"),
        row.get("ebay_item_id"),
        row.get("title"),
        row.get("price_value"),
        row.get("price_currency"),
        row.get("shipping_label"),
        row.get("sold_date"),
        row.get("sold_date_label"),
        row.get("thumbnail_url"),
        row.get("item_web_url"),
        row.get("condition"),
        row.get("source_query"),
        row.get("match_confidence"),
        row.get("auction_id"),
        row.get("lot_number"),
        row.get("cannons_title"),
        row.get("cannons_description"),
        row.get("current_bid"),
        row.get("total_bids"),
        row.get("detail_url"),
        row.get("raw_match_json"),
    )


def ensure_comp_tables(connection) -> None:
    connection.execute(CREATE_COMP_TABLE_SQL)
    connection.execute(PUBLIC_VIEW_SQL)


def insert_comp_rows(connection, rows: list[dict]) -> int:
    if not rows:
        return 0
    connection.executemany(INSERT_COMP_SQL, [comp_row_values(row) for row in rows])
    return len(rows)


def append_ebay_comp_snapshots(rows: list[dict], database: str | None = None) -> int:
    if not rows:
        return 0

    import warehouse

    connection = warehouse.connect(database, "append eBay comps to MotherDuck")
    try:
        ensure_comp_tables(connection)
        return insert_comp_rows(connection, rows)
    finally:
        connection.close()
