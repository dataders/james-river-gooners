"""Active + archived lot listings → Supabase (issue #98).

Mirrors the NDJSON read model into the Supabase ``lots`` table so the browser
queries PostgREST on tab open instead of 21 parallel file fetches. The browser
still loads the full dataset and filters client-side, so filter/sort/search
latency is unchanged.

Writes use the secret key (bypasses RLS); the browser reads
``public_active_lots`` / ``public_archived_lots`` with the publishable key.

Also provides read-back helpers (``fetch_lots_for_auction``,
``list_auction_safe_ids``) used by the ``--from-supabase`` backfill paths in
``embed_nomic.py``, ``enrich.py``, and ``sold_history.py`` so those workflows
can run without committed NDJSON files.

CLI usage (one-time backfill of existing NDJSON files):
    uv run --with requests python3 supabase_lots.py --backfill
    uv run --with requests python3 supabase_lots.py --backfill --active-only
    uv run --with requests python3 supabase_lots.py --backfill --archived-only
"""

import argparse
import json
import os
from pathlib import Path
from typing import Optional

from supabase_comps import (
    READ_TIMEOUT,
    _request_with_retry,
    json_safe,
    resolve_credentials,
)

LOTS_TABLE = "lots"
DEFAULT_BATCH_SIZE = 500

# Read pagination page size. Smaller pages keep each request cheap so a read can
# ride under the timeout even when the shared compute is busy serving the SPA's
# heavy full-dataset reads (the dominant DB load). Tunable via env for a backfill
# against a saturated instance; the default keeps prior behaviour.
READ_PAGE_SIZE = int(os.environ.get("GOONERS_SUPABASE_PAGE", "1000"))

_REPO_ROOT = Path(__file__).resolve().parent.parent
ITEMS_DIR = _REPO_ROOT / "public" / "data" / "items"
ARCHIVE_ITEMS_DIR = _REPO_ROOT / "public" / "data" / "archive" / "items"


def _to_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# Per-scrape mutable fields used to detect whether a stored lot actually changed
# (#242). ``scrapedAt`` is deliberately excluded: it changes on every run, so
# diffing on it would never let us skip anything. These four are what
# legitimately change while an auction is live — bid state and (soft-close) end
# date. Both sides are normalised so a numeric(12,2) round-trip ("42.50" vs
# 42.5) doesn't read as a change.
def _change_signature(current_bid, total_bids, unique_bidders, end_date) -> tuple:
    return (
        _to_float(current_bid),
        _to_int(total_bids),
        _to_int(unique_bidders),
        end_date or None,
    )


def _lot_row(item: dict, archived: bool = False) -> dict:
    """Convert a camelCase NDJSON item dict to a snake_case Supabase row."""
    images = item.get("images", [])
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except Exception:
            images = [images] if images else []

    row: dict = {
        "auction_safe_id": item.get("auctionSafeId"),
        "item_id": item.get("id"),
        "lot_number": item.get("lotNumber"),
        "title": item.get("title"),
        "description": item.get("description"),
        "current_bid": _to_float(item.get("currentBid")),
        "total_bids": item.get("totalBids"),
        "unique_bidders": item.get("uniqueBidders"),
        "end_date": item.get("endDate"),
        "images": images,
        "category": item.get("category"),
        "raw_category": item.get("rawCategory"),
        "detail_url": item.get("detailUrl"),
        "auction_id": item.get("auctionId"),
        "auction_title": item.get("auctionTitle"),
        "auction_end_date": item.get("auctionEndDate"),
        "scraped_at": item.get("scrapedAt"),
        "source": item.get("source"),
        "archived": archived,
    }
    if archived:
        row["final_bid"] = _to_float(item.get("finalBid"))
        row["closed"] = item.get("closed")
    return {k: json_safe(v) for k, v in row.items()}


def _post_batch(rows: list[dict], url: str, key: str, session) -> None:
    endpoint = f"{url.rstrip('/')}/rest/v1/{LOTS_TABLE}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    resp = session.post(endpoint, json=rows, headers=headers)
    if not resp.ok:
        raise RuntimeError(f"lots upsert failed: {resp.status_code} {resp.text[:300]}")


def _fetch_existing_signatures(safe_id: str, url: str, key: str, session) -> dict:
    """Return ``{item_id: change_signature}`` for an auction's stored active lots.

    Used to skip re-upserting unchanged lots (#242). Selects only the mutable
    columns we diff on, not the whole row. Returns an empty dict on any failure
    so the caller safely falls back to upserting everything (correct, just not
    optimised).
    """
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    try:
        rows = _get_paginated(
            f"{url.rstrip('/')}/rest/v1/{LOTS_TABLE}",
            headers,
            {
                "auction_safe_id": f"eq.{safe_id}",
                "archived": "eq.false",
                "select": "item_id,current_bid,total_bids,unique_bidders,end_date",
            },
            session,
        )
    except Exception:
        return {}
    return {
        row["item_id"]: _change_signature(
            row.get("current_bid"),
            row.get("total_bids"),
            row.get("unique_bidders"),
            row.get("end_date"),
        )
        for row in rows
        if row.get("item_id")
    }


def upsert_lots(
    items: list[dict],
    safe_id: str,
    *,
    url: str = None,
    key: str = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    skip_unchanged: bool = True,
) -> int:
    """Upsert active items for one auction into ``lots``. Returns row count.

    When ``skip_unchanged`` is set (the default), the stored rows are diffed
    against the incoming lots first and only new or genuinely-changed lots are
    upserted — every scrape used to re-write every active lot even when nothing
    changed, causing write amplification and reader/writer contention (#242).
    """
    if not items:
        return 0
    url, key = resolve_credentials(url, key)
    if not url or not key:
        return 0

    if session is None:
        import requests as _requests
        session = _requests.Session()

    if skip_unchanged:
        existing = _fetch_existing_signatures(safe_id, url, key, session)
        if existing:
            before = len(items)
            items = [
                item
                for item in items
                if existing.get(item.get("id"))
                != _change_signature(
                    item.get("currentBid"),
                    item.get("totalBids"),
                    item.get("uniqueBidders"),
                    item.get("endDate"),
                )
            ]
            skipped = before - len(items)
            if skipped:
                print(f"Skipped {skipped} unchanged lot(s) for {safe_id}")
        if not items:
            print(f"No changed lots for {safe_id}; skipping Supabase upsert")
            return 0

    rows = [_lot_row(item) for item in items]
    for i in range(0, len(rows), batch_size):
        _post_batch(rows[i : i + batch_size], url, key, session)

    print(f"Upserted {len(rows)} lots for {safe_id} to Supabase")
    return len(rows)


def archive_lots(
    safe_id: str,
    final_items: list[dict],
    *,
    url: str = None,
    key: str = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Mark all lots for ``safe_id`` as archived and write final prices."""
    if not final_items:
        return 0
    url, key = resolve_credentials(url, key)
    if not url or not key:
        return 0

    if session is None:
        import requests as _requests
        session = _requests.Session()

    rows = [_lot_row(item, archived=True) for item in final_items]
    for i in range(0, len(rows), batch_size):
        _post_batch(rows[i : i + batch_size], url, key, session)

    print(f"Archived {len(rows)} lots for {safe_id} in Supabase")
    return len(rows)


def _row_to_item(row: dict) -> dict:
    """Convert a Supabase snake_case ``lots`` row to the camelCase item dict."""
    images = row.get("images") or []
    if isinstance(images, str):
        try:
            images = json.loads(images)
        except Exception:
            images = [images] if images else []
    return {
        "auctionSafeId": row.get("auction_safe_id"),
        "id": row.get("item_id"),
        "lotNumber": row.get("lot_number"),
        "title": row.get("title"),
        "description": row.get("description"),
        "currentBid": row.get("current_bid"),
        "totalBids": row.get("total_bids"),
        "uniqueBidders": row.get("unique_bidders"),
        "endDate": row.get("end_date"),
        "images": images,
        "category": row.get("category"),
        "rawCategory": row.get("raw_category"),
        "detailUrl": row.get("detail_url"),
        "auctionId": row.get("auction_id"),
        "auctionTitle": row.get("auction_title"),
        "auctionEndDate": row.get("auction_end_date"),
        "scrapedAt": row.get("scraped_at"),
        "source": row.get("source"),
        "finalBid": row.get("final_bid"),
        "closed": row.get("closed"),
    }


def _get_paginated(endpoint: str, headers: dict, params: dict, session) -> list[dict]:
    """Paginate through a PostgREST endpoint and return all rows.

    Each page GET retries transient failures (network/timeout/429/5xx) with
    backoff via the shared helper, and uses the generous shared read timeout.
    A full-table scan here is dozens of sequential requests, so one blip must
    not abort the whole ``--from-supabase`` backfill — the same reason
    ``comp_item_freshness`` needed it (a flat 30s read fired as an unretryable
    ReadTimeout)."""
    PAGE = READ_PAGE_SIZE
    rows = []
    offset = 0
    while True:
        page_headers = {**headers, "Range": f"{offset}-{offset + PAGE - 1}"}
        resp = _request_with_retry(
            lambda h=page_headers: session.get(
                endpoint, headers=h, params=params, timeout=READ_TIMEOUT,
            ),
            f"Supabase GET {endpoint}",
        )
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += len(batch)
    return rows


def list_auction_safe_ids(
    *,
    url: str = None,
    key: str = None,
    session=None,
    archived: bool = False,
) -> list[str]:
    """Return all distinct auction_safe_id values from the lots table."""
    url, key = resolve_credentials(url, key)
    if session is None:
        import requests as _requests
        session = _requests.Session()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    rows = _get_paginated(
        f"{url.rstrip('/')}/rest/v1/{LOTS_TABLE}",
        headers,
        {"select": "auction_safe_id", "archived": f"eq.{str(archived).lower()}"},
        session,
    )
    seen: set = set()
    ids = []
    for row in rows:
        sid = row.get("auction_safe_id")
        if sid and sid not in seen:
            seen.add(sid)
            ids.append(sid)
    return ids


def fetch_lots_for_auction(
    safe_id: str,
    *,
    url: str = None,
    key: str = None,
    session=None,
    archived: bool = False,
) -> list[dict]:
    """Fetch all lots for one auction from Supabase as camelCase item dicts."""
    url, key = resolve_credentials(url, key)
    if session is None:
        import requests as _requests
        session = _requests.Session()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    rows = _get_paginated(
        f"{url.rstrip('/')}/rest/v1/{LOTS_TABLE}",
        headers,
        {
            "auction_safe_id": f"eq.{safe_id}",
            "archived": f"eq.{str(archived).lower()}",
            "select": "*",
        },
        session,
    )
    return [_row_to_item(r) for r in rows]


def backfill(
    *,
    url: str = None,
    key: str = None,
    session=None,
    do_active: bool = True,
    do_archived: bool = True,
) -> tuple[int, int]:
    """Read all existing NDJSON files and upsert into Supabase.

    Returns ``(active_count, archived_count)``.
    """
    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required for backfill")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required for backfill")

    if session is None:
        import requests as _requests
        session = _requests.Session()

    active_total = 0
    if do_active and ITEMS_DIR.exists():
        paths = sorted(ITEMS_DIR.glob("*.ndjson"))
        print(f"Backfilling {len(paths)} active auction file(s)…")
        for ndjson_path in paths:
            items = [json.loads(line) for line in ndjson_path.read_text().splitlines() if line.strip()]
            if items:
                active_total += upsert_lots(
                    items, ndjson_path.stem, url=url, key=key, session=session,
                    skip_unchanged=False,
                )

    archived_total = 0
    if do_archived and ARCHIVE_ITEMS_DIR.exists():
        paths = sorted(ARCHIVE_ITEMS_DIR.glob("*.ndjson"))
        print(f"Backfilling {len(paths)} archived auction file(s)…")
        for ndjson_path in paths:
            items = [json.loads(line) for line in ndjson_path.read_text().splitlines() if line.strip()]
            if items:
                archived_total += archive_lots(ndjson_path.stem, items, url=url, key=key, session=session)

    return active_total, archived_total


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill existing NDJSON files into the Supabase lots table"
    )
    parser.add_argument("--backfill", action="store_true", help="Run the backfill")
    parser.add_argument("--active-only", action="store_true", help="Backfill active lots only")
    parser.add_argument("--archived-only", action="store_true", help="Backfill archived lots only")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    if not args.backfill:
        print("Pass --backfill to run. See --help for options.")
        raise SystemExit(1)

    active_count, archived_count = backfill(
        do_active=not args.archived_only,
        do_archived=not args.active_only,
    )
    print(f"Backfill complete: {active_count} active lots, {archived_count} archived lots")
