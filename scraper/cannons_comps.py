#!/usr/bin/env python
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "requests",
# ]
# ///
"""
Precompute "Cannon's comps": for each active auction item, the most similar
*past* (archived) lots and what they actually sold for.

This is the historical-sold-price counterpart to eBay comps. Matching is Nomic
semantic similarity (text + vision) run **server-side in Postgres**: the active
and archived lots are already embedded in the Supabase ``nomic_embeddings``
pgvector table (by the scrape's incremental embed step + the archive backfill
workflow), and the ``match_cannons_comps`` RPC finds, for every active item, its
top-K most similar *sold* archived lots (cosine over the HNSW index, joined to
``sold_lots`` for the realized price + display fields). No model, no in-process
corpus, no committed ``.embeddings`` sidecars — the whole job is a few RPC calls.

Pipeline:
  1. For each active auction in the manifest, call ``match_cannons_comps`` with
     the top-K / min-sim thresholds.
  2. Group the returned matches by active item id (the RPC already orders them
     best-first) and write them to the Supabase ``cannons_comp_snapshots`` table
     (the auth-gated read model; the browser reads ``public_cannons_comps``,
     #132 part 3 / #150).

Supabase is required (it holds both the embeddings and the comp read model); with
no ``SUPABASE_SECRET_KEY`` this is a no-op, like eBay comps.

Usage (from scraper/):
    uv run --with requests python cannons_comps.py --top-k 3 --min-sim 0.80
"""

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

# Server-side PostHog telemetry (shared scraper helper). Silent no-op unless
# GOONERS_POSTHOG_KEY is set AND the posthog SDK imports; never raises into the
# caller. Guarded so a missing module can't break the comps job.
try:
    from telemetry import capture as _telemetry_capture
    from telemetry import flush as _telemetry_flush
except Exception:  # pragma: no cover - telemetry is best-effort

    def _telemetry_capture(event, properties=None):
        return None

    def _telemetry_flush():
        return None


DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
SCHEMA_VERSION = 1
DEFAULT_TOP_K = 3
DEFAULT_MIN_SIM = 0.80
RPC_NAME = "match_cannons_comps"


def utc_now_text() -> str:
    return datetime.now(UTC).isoformat()


def read_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    manifest = json.loads(path.read_text())
    return (
        manifest.get("auctions", manifest) if isinstance(manifest, dict) else manifest
    )


def _headers(key: str, extra: dict | None = None) -> dict:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    if extra:
        headers.update(extra)
    return headers


def fetch_comps(
    session, url: str, key: str, safe_id: str, top_k: int, min_sim: float
) -> list[dict]:
    """Call the match_cannons_comps RPC for one active auction."""
    endpoint = f"{url.rstrip('/')}/rest/v1/rpc/{RPC_NAME}"
    body = {"active_auction": safe_id, "match_count": top_k, "min_sim": min_sim}
    resp = session.post(
        endpoint,
        headers=_headers(key, {"Content-Type": "application/json"}),
        data=json.dumps(body),
        timeout=200,
    )
    if resp.status_code >= 400:
        raise RuntimeError(f"{RPC_NAME} failed ({resp.status_code}): {resp.text[:300]}")
    return resp.json()


def shape_match(row: dict) -> dict:
    """Shape one RPC row as a comp match for the read model (supabase_cannons_comps)."""
    price = row.get("sold_price")
    return {
        "title": row.get("title"),
        "soldPrice": round(float(price), 2) if price is not None else None,
        "soldDate": row.get("sold_at"),
        "thumbnailUrl": row.get("image_url"),
        "detailUrl": row.get("detail_url"),
        "auctionTitle": row.get("auction_title"),
        "source": row.get("source"),
        "similarity": round(float(row.get("similarity") or 0.0), 4),
    }


def build_comps(
    data_dir: Path = DATA_DIR,
    top_k: int = DEFAULT_TOP_K,
    min_sim: float = DEFAULT_MIN_SIM,
    active_limit: int | None = None,
    dry_run: bool = False,
    supabase_url: str | None = None,
    supabase_key: str | None = None,
    from_supabase: bool = False,
) -> dict:
    """Match active items to sold archived lots via the Nomic pgvector RPC and
    write the comp read model to Supabase (``cannons_comp_snapshots``)."""
    summary = {
        "auctions": 0,
        "items_with_comps": 0,
        "matches": 0,
        "auctions_written": 0,
        "rows_written": 0,
    }

    if from_supabase:
        # Active auctions from Supabase (the source of truth). The committed read
        # model / manifest isn't present on a fresh CI checkout, so a standalone
        # dispatch needs this to find anything to comp.
        from supabase_lots import list_auction_safe_ids

        active_entries = [
            {"safeId": sid} for sid in list_auction_safe_ids(archived=False)
        ]
    else:
        active_entries = read_manifest(data_dir / "manifest.json")
    if active_limit is not None:
        active_entries = active_entries[:active_limit]
    if not active_entries:
        print("No active auctions; nothing to do.")
        return summary

    if not supabase_url or not supabase_key:
        print(
            "Cannon's comps require Supabase (Nomic pgvector) — set SUPABASE_URL + "
            "SUPABASE_SECRET_KEY. Nothing to do."
        )
        return summary

    import requests
    from supabase_cannons_comps import write_auction_comps

    session = requests.Session()
    generated_at = utc_now_text()
    print(
        f"Building Cannon's comps via {RPC_NAME} for {len(active_entries)} active auctions..."
    )

    for entry in active_entries:
        safe_id = entry.get("safeId")
        if not safe_id:
            continue
        rows = fetch_comps(session, supabase_url, supabase_key, safe_id, top_k, min_sim)

        # The RPC orders rows by (item_id, similarity desc), so appending in order
        # preserves best-first ranking per item.
        item_exports: dict[str, dict] = {}
        for row in rows:
            item_exports.setdefault(str(row["item_id"]), {"matches": []})[
                "matches"
            ].append(shape_match(row))

        summary["auctions"] += 1
        summary["items_with_comps"] += len(item_exports)
        summary["matches"] += sum(len(v["matches"]) for v in item_exports.values())
        if not item_exports:
            continue

        if dry_run:
            print(
                f"  {safe_id}: {len(item_exports)} items matched (dry-run, not written)"
            )
            continue

        written = write_auction_comps(
            safe_id,
            item_exports,
            generated_at,
            url=supabase_url,
            key=supabase_key,
            session=session,
        )
        summary["auctions_written"] += 1
        summary["rows_written"] += written
        print(f"  {safe_id}: {len(item_exports)} items matched, {written} rows")

    print(
        f"Cannon's comps: {summary['items_with_comps']} items matched across "
        f"{summary['auctions']} auctions, {summary['matches']} matches, "
        f"{summary['rows_written']} rows → Supabase ({summary['auctions_written']} auctions)"
    )
    _telemetry_capture(
        "cannons_comps_completed",
        {
            "auctions": summary["auctions"],
            "items_with_comps": summary["items_with_comps"],
            "matches": summary["matches"],
            "auctions_written": summary["auctions_written"],
            "rows_written": summary["rows_written"],
            "top_k": top_k,
            "min_sim": min_sim,
            "dry_run": dry_run,
        },
    )
    return summary


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Precompute Cannon's (archive) comps via Nomic pgvector"
    )
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument(
        "--top-k",
        type=int,
        default=int(os.environ.get("GOONERS_CANNONS_COMPS_TOP_K", DEFAULT_TOP_K)),
    )
    parser.add_argument(
        "--min-sim",
        type=float,
        default=float(os.environ.get("GOONERS_CANNONS_COMPS_MIN_SIM", DEFAULT_MIN_SIM)),
    )
    parser.add_argument(
        "--active-limit",
        type=int,
        default=None,
        help="Only process the first N active auctions (for quick validation).",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--from-supabase",
        action="store_true",
        help="Read the active-auction list from Supabase (lots table) instead of "
        "the local manifest — needed in CI, where the read model isn't checked out.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    from supabase_comps import resolve_credentials

    supabase_url, supabase_key = resolve_credentials()
    build_comps(
        data_dir=args.data_dir,
        top_k=args.top_k,
        min_sim=args.min_sim,
        active_limit=args.active_limit,
        dry_run=args.dry_run,
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        from_supabase=args.from_supabase,
    )
    _telemetry_flush()  # ship events before this short-lived process exits
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
