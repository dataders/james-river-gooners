"""Cannon's comps → Supabase (issue #132 part 3 / #150).

Writes the precomputed Cannon's comps (the most similar past sold lots per active
item, from ``cannons_comps.py``) to the Supabase ``cannons_comp_snapshots``
table, replacing the static ``public/data/cannons-comps/*.json`` read model. The
browser reads the ``public_cannons_comps`` view (publishable key); that view is
gated to authenticated sessions by RLS (#150), so logged-out users read zero
rows — the gating #149 could only fake at the UI level is now enforced.

Writes use the secret key (``SUPABASE_SECRET_KEY``, service_role — bypasses RLS)
via the same PostgREST mechanics as ``supabase_comps.py`` / ``sold_history.py``.
Per auction the writer inserts the run's rows (tagged ``generated_at``) then
deletes that auction's older generations, so the table holds exactly the latest
comps and stays bounded (insert-before-delete leaves no empty window).
"""

import json

from supabase_comps import json_safe, resolve_credentials

CANNONS_COMP_TABLE = "cannons_comp_snapshots"

# Columns written per row; mirrors the table (0009_cannons_comps.sql). `id` and
# `ingested_at` are Postgres-filled and deliberately omitted.
CANNONS_COMP_COLUMNS = (
    "auction_safe_id",
    "item_id",
    "rank",
    "match_title",
    "sold_price",
    "sold_date",
    "thumbnail_url",
    "detail_url",
    "auction_title",
    "source",
    "similarity",
    "generated_at",
)

DEFAULT_BATCH_SIZE = 500


def comp_rows(safe_id: str, item_exports: dict, generated_at: str) -> list[dict]:
    """Flatten ``{item_id: {"matches": [...]}}`` into table rows.

    Each match becomes one row; ``rank`` preserves the best-first order the
    matcher produced (``cannons_comps.top_matches`` sorts by descending
    similarity).
    """
    rows: list[dict] = []
    for item_id, entry in (item_exports or {}).items():
        for rank, match in enumerate(entry.get("matches", [])):
            row = {
                "auction_safe_id": safe_id,
                "item_id": str(item_id),
                "rank": rank,
                "match_title": match.get("title"),
                "sold_price": match.get("soldPrice"),
                "sold_date": match.get("soldDate"),
                "thumbnail_url": match.get("thumbnailUrl"),
                "detail_url": match.get("detailUrl"),
                "auction_title": match.get("auctionTitle"),
                "source": match.get("source"),
                "similarity": match.get("similarity"),
                "generated_at": generated_at,
            }
            rows.append({c: json_safe(row.get(c)) for c in CANNONS_COMP_COLUMNS})
    return rows


def _headers(key: str, extra: dict | None = None) -> dict:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if extra:
        headers.update(extra)
    return headers


def write_auction_comps(
    safe_id: str,
    item_exports: dict,
    generated_at: str,
    url: str | None = None,
    key: str | None = None,
    session=None,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> int:
    """Insert one auction's comps, then drop its older generations.

    Returns the number of rows written. Insert happens before the prune, so the
    auction always has a complete generation visible to the view.
    """
    url, key = resolve_credentials(url, key)
    if not url:
        raise RuntimeError("SUPABASE_URL is required to write Cannon's comps to Supabase")
    if not key:
        raise RuntimeError("SUPABASE_SECRET_KEY is required to write Cannon's comps to Supabase")

    rows = comp_rows(safe_id, item_exports, generated_at)
    if not rows:
        return 0

    if session is None:
        from http_client import supabase_session

        session = supabase_session("cannons-comps")
    endpoint = f"{url.rstrip('/')}/rest/v1/{CANNONS_COMP_TABLE}"

    written = 0
    insert_headers = _headers(key, {"Content-Type": "application/json", "Prefer": "return=minimal"})
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        response = session.post(endpoint, headers=insert_headers, data=json.dumps(batch), timeout=30)
        if response.status_code >= 400:
            raise RuntimeError(
                f"Supabase cannons comp insert failed ({response.status_code}): {response.text[:300]}"
            )
        written += len(batch)

    # Drop older generations for this auction so only the latest remains.
    prune = session.delete(
        endpoint,
        headers=_headers(key, {"Prefer": "return=minimal"}),
        params={"auction_safe_id": f"eq.{safe_id}", "generated_at": f"lt.{generated_at}"},
        timeout=30,
    )
    if prune.status_code >= 400:
        raise RuntimeError(
            f"Supabase cannons comp prune failed ({prune.status_code}): {prune.text[:300]}"
        )

    return written
