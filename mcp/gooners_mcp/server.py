"""FastMCP tool definitions for the gooners read model.

Tools are thin closures over a GoonersClient. They never raise: every tool returns
either its result dict/list or {"error": "..."}.
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from typing import Any

from fastmcp import FastMCP

from .client import AuthRequiredError, GoonersClient
from .schemas import (
    composite_key,
    shape_cannons_comp,
    shape_category_stats,
    shape_ebay_comp,
    shape_lot,
)


def _safe(fn: Callable) -> Callable:
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except AuthRequiredError as exc:
            return {"error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - tools must never raise
            return {"error": f"{type(exc).__name__}: {exc}"}

    return wrapper


def _sanitize_ilike(query: str) -> str:
    """Strip PostgREST reserved chars that would break the or=(...) filter syntax."""
    for ch in (",", "(", ")", "*", "%"):
        query = query.replace(ch, "")
    return query.strip()


def _enrichment_for(
    client: GoonersClient, keys: list[tuple[str, str]]
) -> dict[str, dict]:
    """Fetch enrichment rows for (safe_id, item_id) pairs -> {composite_key: row}."""
    if not keys:
        return {}
    safe_ids = sorted({k[0] for k in keys})
    item_ids = sorted({k[1] for k in keys})
    rows = client.get(
        "/rest/v1/public_lot_enrichment",
        {
            "auction_safe_id": f"in.({','.join(safe_ids)})",
            "item_id": f"in.({','.join(item_ids)})",
        },
    )
    return {composite_key(r["auction_safe_id"], r["item_id"]): r for r in rows}


def build_server(client: GoonersClient) -> FastMCP:
    mcp = FastMCP("gooners")

    @mcp.tool
    @_safe
    def list_auctions() -> dict:
        """List the currently active auctions (id, title, end date)."""
        rows = client.get(
            "/rest/v1/public_active_lots",
            {
                "select": "auction_safe_id,auction_title,auction_end_date",
                "limit": "10000",  # active lots can number several thousand; dedupe to auctions client-side
            },
        )
        seen: dict[str, dict] = {}
        for r in rows:
            sid = r.get("auction_safe_id")
            if sid and sid not in seen:
                seen[sid] = {
                    "auction_safe_id": sid,
                    "title": r.get("auction_title"),
                    "end_date": r.get("auction_end_date"),
                }
        return {"auctions": list(seen.values())}

    def _keyword_lots(query, category, max_price, auction_safe_id, limit) -> list[dict]:
        params: dict[str, Any] = {"limit": str(limit), "order": "current_bid.desc"}
        q = _sanitize_ilike(query)
        if q:
            params["or"] = f"(title.ilike.*{q}*,description.ilike.*{q}*)"
        if category:
            params["category"] = f"eq.{category}"
        if max_price is not None:
            params["current_bid"] = f"lte.{max_price}"
        if auction_safe_id:
            params["auction_safe_id"] = f"eq.{auction_safe_id}"
        return client.get("/rest/v1/public_active_lots", params)

    def _semantic_lots(query, limit) -> list[dict]:
        res = client.edge_fn("embed-query", {"query": query, "match_count": limit})
        ids = [tuple(i.split(":", 1)) for i in res.get("ids", []) if ":" in i][:limit]
        if not ids:
            return []
        safe_ids = sorted({a for a, _ in ids})
        item_ids = sorted({b for _, b in ids})
        lots = client.get(
            "/rest/v1/public_active_lots",
            {
                "auction_safe_id": f"in.({','.join(safe_ids)})",
                "item_id": f"in.({','.join(item_ids)})",
            },
        )
        by_key = {
            composite_key(lot["auction_safe_id"], lot["item_id"]): lot for lot in lots
        }
        return [
            by_key[f"{a}:{b}"] for a, b in ids if f"{a}:{b}" in by_key
        ]  # preserve rank

    @mcp.tool
    @_safe
    def search_lots(
        query: str = "",
        semantic: bool = False,
        category: str | None = None,
        max_price: float | None = None,
        auction_safe_id: str | None = None,
        limit: int = 50,
    ) -> dict:
        """Search active auction lots. Keyword/filter by default; set semantic=True
        for meaning-based search. Filters: category, max_price, auction_safe_id (the id from list_auctions)."""
        fallback = False
        if semantic and query:
            try:
                ordered = _semantic_lots(query, limit)
            except Exception:  # noqa: BLE001 - embed-query may be undeployed/rate-limited
                fallback = True
                ordered = _keyword_lots(
                    query, category, max_price, auction_safe_id, limit
                )
        else:
            ordered = _keyword_lots(query, category, max_price, auction_safe_id, limit)

        keys = [(lot["auction_safe_id"], str(lot["item_id"])) for lot in ordered]
        enrich = _enrichment_for(client, keys)
        out: dict[str, object] = {
            "results": [
                shape_lot(
                    lot,
                    enrich.get(composite_key(lot["auction_safe_id"], lot["item_id"])),
                )
                for lot in ordered
            ]
        }
        if fallback:
            out["semantic_fallback"] = True
        return out

    @mcp.tool
    @_safe
    def get_lot(auction_safe_id: str, item_id: str) -> dict:
        """Full detail for one lot, including resale enrichment when identified."""
        lots = client.get(
            "/rest/v1/public_active_lots",
            {
                "auction_safe_id": f"eq.{auction_safe_id}",
                "item_id": f"eq.{item_id}",
                "limit": "1",
            },
        )
        if not lots:
            return {"error": f"No active lot {auction_safe_id}:{item_id}"}
        enrich = client.get(
            "/rest/v1/public_lot_enrichment",
            {
                "auction_safe_id": f"eq.{auction_safe_id}",
                "item_id": f"eq.{item_id}",
                "limit": "1",
            },
        )
        return shape_lot(lots[0], enrich[0] if enrich else None)

    @mcp.tool
    @_safe
    def get_comps(auction_safe_id: str, item_id: str) -> dict:
        """eBay sold comps + Cannon's similar-lot comps for resale research (login required)."""
        ebay = client.get(
            "/rest/v1/public_auction_comps",
            {
                "auction_safe_id": f"eq.{auction_safe_id}",
                "item_id": f"eq.{item_id}",
            },
            auth=True,
        )
        cannons = client.get(
            "/rest/v1/public_cannons_comps",
            {
                "auction_safe_id": f"eq.{auction_safe_id}",
                "item_id": f"eq.{item_id}",
                "order": "rank.asc",
            },
            auth=True,
        )
        return {
            "ebay": [shape_ebay_comp(r) for r in ebay],
            "cannons": [shape_cannons_comp(r) for r in cannons],
        }

    @mcp.tool
    @_safe
    def get_category_sold_stats(category: str) -> dict:
        """Median/range/recency of past sold prices for a category (login required)."""
        rows = client.get(
            "/rest/v1/public_category_sold_stats",
            {
                "category": f"eq.{category}",
                "limit": "1",
            },
            auth=True,
        )
        return shape_category_stats(rows[0]) if rows else {}

    # ---- favorites / ignored (login required) ---------------------------
    def _list_keys(table: str) -> dict:
        rows = client.get(
            f"/rest/v1/{table}",
            {"select": "item_key,created_at", "order": "created_at.desc"},
            auth=True,
        )
        return {table: [r["item_key"] for r in rows]}

    def _add_key(table: str, auction_safe_id: str, item_id: str) -> dict:
        if not client.user_id:
            client.login()
        client.post(
            f"/rest/v1/{table}",
            {
                "user_id": client.user_id,
                "item_key": composite_key(auction_safe_id, item_id),
            },
            auth=True,
            prefer="resolution=merge-duplicates",
        )
        return {"ok": True}

    def _remove_key(table: str, auction_safe_id: str, item_id: str) -> dict:
        client.delete(
            f"/rest/v1/{table}",
            {"item_key": f"eq.{composite_key(auction_safe_id, item_id)}"},
            auth=True,
        )
        return {"ok": True}

    @mcp.tool
    @_safe
    def list_favorites() -> dict:
        """List the item keys the user has favorited (login required)."""
        return _list_keys("favorites")

    @mcp.tool
    @_safe
    def add_favorite(auction_safe_id: str, item_id: str) -> dict:
        """Favorite a lot (login required)."""
        return _add_key("favorites", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def remove_favorite(auction_safe_id: str, item_id: str) -> dict:
        """Remove a favorite (login required)."""
        return _remove_key("favorites", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def list_ignored() -> dict:
        """List the item keys the user marked 'not interested' (login required)."""
        return _list_keys("ignored")

    @mcp.tool
    @_safe
    def add_ignored(auction_safe_id: str, item_id: str) -> dict:
        """Mark a lot 'not interested' (login required)."""
        return _add_key("ignored", auction_safe_id, item_id)

    @mcp.tool
    @_safe
    def remove_ignored(auction_safe_id: str, item_id: str) -> dict:
        """Remove a lot from the 'not interested' list (login required)."""
        return _remove_key("ignored", auction_safe_id, item_id)

    return mcp
