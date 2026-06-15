"""Shared helpers used across all three auction scrapers (Cannon's, HiBid, Rasmus).

Centralises the bid-change detection pattern that each scraper previously
duplicated locally.
"""

import json
from pathlib import Path


def load_existing_bids(path: Path) -> dict[str, tuple[float, int]]:
    """Return ``{item_id: (currentBid, totalBids)}`` from a saved read-model file.

    Tries the NDJSON sidecar first (more up-to-date on an in-progress scrape),
    then falls back to the Parquet file. Returns an empty dict when neither
    exists or both fail to parse.
    """
    ndjson_path = path.with_suffix(".ndjson")
    if ndjson_path.exists():
        try:
            rows = [
                json.loads(line)
                for line in ndjson_path.read_text().splitlines()
                if line.strip()
            ]
            return {
                row["id"]: (
                    float(row.get("currentBid") or 0),
                    int(row.get("totalBids") or 0),
                )
                for row in rows
            }
        except Exception:
            pass
    if not path.exists():
        return {}
    try:
        import pyarrow.parquet as pq

        table = pq.read_table(path, columns=["id", "currentBid", "totalBids"])
        return {
            row["id"]: (float(row["currentBid"] or 0), int(row["totalBids"] or 0))
            for row in table.to_pylist()
        }
    except Exception:
        return {}


def load_existing_unique_bidders(path: Path) -> dict[str, int]:
    """Return ``{item_id: uniqueBidders}`` from a saved read-model file.

    Used to carry forward the distinct-bidder count for lots whose bid count
    hasn't changed, so a re-scrape only re-fetches bid history for active lots.
    Tries NDJSON first, then Parquet. Returns an empty dict on any failure.
    """
    ndjson_path = path.with_suffix(".ndjson")
    if ndjson_path.exists():
        try:
            out: dict[str, int] = {}
            for line in ndjson_path.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if row.get("uniqueBidders") is not None:
                    out[row["id"]] = int(row["uniqueBidders"])
            return out
        except Exception:
            pass
    if not path.exists():
        return {}
    try:
        import pyarrow.parquet as pq

        table = pq.read_table(path, columns=["id", "uniqueBidders"])
        return {
            row["id"]: int(row["uniqueBidders"])
            for row in table.to_pylist()
            if row.get("uniqueBidders") is not None
        }
    except Exception:
        return {}


def has_bid_changes(new_items: list[dict], existing_bids: dict) -> bool:
    """Return True when the new item list differs from the saved bid snapshot.

    A mismatch on item count or any (currentBid, totalBids) pair is treated as
    changed. An empty ``existing_bids`` always returns True so a first-run
    write is never skipped.
    """
    if not existing_bids:
        return True
    new_ids = {item["id"] for item in new_items}
    if new_ids != set(existing_bids):
        return True
    return any(
        (float(item.get("currentBid") or 0), int(item.get("totalBids") or 0))
        != existing_bids.get(item["id"])
        for item in new_items
    )
