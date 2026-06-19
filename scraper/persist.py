"""Shared read-model write path for all three auction scrapers.

Every scraper (Cannon's/Maxanet, HiBid, Rasmus) builds a list of lots in the
shared item schema and then runs the *identical* write tail: stamp auction
metadata onto each lot, run LLM enrichment, write the NDJSON sidecar, upsert to
Supabase, generate Nomic embeddings, write the Parquet warehouse file, and
optionally snapshot to MotherDuck. That tail used to be copy-pasted into each
scraper — which is how HiBid and Rasmus silently drifted out of the embeddings
step. :func:`write_read_model` is the single source of truth for it.

The caller still owns the source-specific work: discovery, fetching/parsing lots
into the shared schema, deriving auction-level metadata, and the no-change skip
check (``load_existing_bids`` / ``has_bid_changes`` in ``scraper_common``). What
varies per source is captured in :class:`WriteContext`.
"""

import json
import secrets
from dataclasses import dataclass
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
ITEMS_DIR = DATA_DIR / "items"


@dataclass
class WriteContext:
    """Everything :func:`write_read_model` needs that varies per source/auction."""

    safe_id: str
    auction_id: str
    auction_title: str
    auction_end_date: str
    source: str  # source slug stamped onto each lot ("cannons", "hibid", a HiBid company slug, …)
    source_url: str  # canonical auction URL, recorded with MotherDuck snapshots
    scraped_at: str  # ISO-8601 string stamped onto each lot
    session: requests.Session | None = None  # reused for Nomic image downloads
    snapshot_to_motherduck: bool | None = (
        None  # None → defer to should_snapshot_to_motherduck()
    )
    # Cannon's closed lots carry no live countdown, so their per-lot endDate is
    # blank; fall back to the auction end date so the UI shows "Ended" rather
    # than an empty countdown. The other sources always have a per-lot endDate.
    fill_blank_end_dates: bool = False


def write_read_model(items: list[dict], ctx: WriteContext) -> dict:
    """Run the shared write tail for a batch of lots. Returns ``{changed, count}``.

    Mutates ``items`` in place (stamps metadata, enriches, and finally
    stringifies ``images`` for Parquet). Callers must have already filtered out
    unchanged auctions via the bid-change skip check.
    """
    ITEMS_DIR.mkdir(parents=True, exist_ok=True)
    items_path = ITEMS_DIR / f"{ctx.safe_id}.parquet"
    ndjson_path = ITEMS_DIR / f"{ctx.safe_id}.ndjson"

    _stamp_auction_metadata(items, ctx)
    _enrich_items(items, ctx, ndjson_path)
    _write_ndjson(items, ndjson_path)
    _upsert_supabase_lots(items, ctx.safe_id)
    _generate_embeddings(items, ctx)
    _write_parquet(items, items_path)
    _snapshot_motherduck(items, ctx)

    return {"changed": True, "count": len(items)}


def _stamp_auction_metadata(items: list[dict], ctx: WriteContext) -> None:
    for item in items:
        item["auctionId"] = ctx.auction_id
        item["auctionSafeId"] = ctx.safe_id
        item["auctionTitle"] = ctx.auction_title
        item["auctionEndDate"] = ctx.auction_end_date
        if ctx.fill_blank_end_dates and not item.get("endDate"):
            item["endDate"] = ctx.auction_end_date
        item["scrapedAt"] = ctx.scraped_at
        item["source"] = ctx.source


def _enrich_items(items: list[dict], ctx: WriteContext, ndjson_path: Path) -> None:
    """LLM metadata enrichment (#99/#104) + Supabase mirror.

    No-op unless GOONERS_ENRICHMENT=1 + ANTHROPIC_API_KEY are set, so default
    behavior is unchanged. Runs while images are still arrays. Hands prior
    enrichment to ``enrich_items`` so unchanged lots reuse it instead of
    re-paying for an identical API call (incremental enrichment).
    """
    from enrich import (
        enrich_items,
        enrichment_summary,
        format_enrichment_summary,
        load_prior_enrichment,
    )

    if secrets.supabase_secret_key():
        from supabase_enrichment import load_prior_enrichment_from_supabase

        prior_by_id = load_prior_enrichment_from_supabase(ctx.safe_id)
    else:
        prior_by_id = load_prior_enrichment(ndjson_path)

    if enrich_items(items, prior_by_id=prior_by_id):
        # Report the medium/high identification rate (what reaches Supabase + the
        # UI), not just the processed count — visible in the workflow logs. Only
        # prints when enrichment actually ran.
        print(format_enrichment_summary(ctx.safe_id, enrichment_summary(items)))

    # Mirror enriched lots into Supabase so they're queryable via the API (#104).
    # No-op without SUPABASE_SECRET_KEY or enriched lots.
    from supabase_enrichment import maybe_export_enrichment

    maybe_export_enrichment(items)


def _write_ndjson(items: list[dict], ndjson_path: Path) -> None:
    """Write the NDJSON sidecar (images stay real arrays — this is what the SPA reads)."""
    lines = [json.dumps(item, separators=(",", ":")) for item in items]
    ndjson_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {len(items)} items to {ndjson_path}")


def _upsert_supabase_lots(items: list[dict], safe_id: str) -> None:
    if secrets.supabase_secret_key():
        from supabase_lots import upsert_lots

        upsert_lots(items, safe_id)


def _generate_embeddings(items: list[dict], ctx: WriteContext) -> None:
    """Nomic text+vision embeddings → Supabase pgvector (#165).

    No-op unless GOONERS_NOMIC_EMBEDDINGS=1 AND SUPABASE_SECRET_KEY are set
    (``maybe_generate_and_upsert`` self-gates), and incremental — only new lots
    are embedded.
    """
    from embed_nomic import maybe_generate_and_upsert

    maybe_generate_and_upsert(items, ctx.safe_id, ctx.session)


def _write_parquet(items: list[dict], items_path: Path) -> None:
    """Write the Parquet warehouse file. Images are stringified (Arrow can't
    infer list-of-strings here), mutating each item in place to match the
    historical on-disk schema."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    for item in items:
        item["images"] = json.dumps(item["images"])
    table = pa.Table.from_pylist(items)
    pq.write_table(table, items_path, compression="snappy")
    print(f"Wrote {len(items)} items to {items_path}")


def _snapshot_motherduck(items: list[dict], ctx: WriteContext) -> None:
    snapshot = ctx.snapshot_to_motherduck
    if snapshot is None:
        from motherduck import should_snapshot_to_motherduck

        snapshot = should_snapshot_to_motherduck()
    if not snapshot:
        return
    from warehouse import get_sink

    sink = get_sink()
    if sink is not None:
        count = sink.append_listing_snapshots(items, ctx.source_url)
        print(f"Appended {count} listing snapshots to the warehouse")
