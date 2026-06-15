import asyncio
from unittest.mock import MagicMock

from gooners_mcp.client import AuthRequiredError
from gooners_mcp.server import build_server


def _tools(client):
    # FastMCP 3.x: list_tools() is async and returns FunctionTool objects with a .fn attr.
    server = build_server(client)
    tool_list = asyncio.run(server.list_tools())
    return {t.name: t.fn for t in tool_list}  # ty: ignore[unresolved-attribute]  # fastmcp Tool.fn (untyped)


def test_get_lot_merges_enrichment():
    client = MagicMock()
    client.get.side_effect = [
        [
            {"auction_safe_id": "A", "item_id": "5", "title": "T", "detail_url": "u"}
        ],  # lot
        [{"brand": "DeWalt", "confidence": "high"}],  # enrichment
    ]
    tools = _tools(client)
    out = tools["get_lot"]("A", "5")
    assert out["brand"] == "DeWalt"
    assert out["source_url"] == "u"


def test_get_lot_not_found():
    client = MagicMock()
    client.get.return_value = []
    tools = _tools(client)
    out = tools["get_lot"]("A", "999")
    assert "error" in out


def test_get_comps_requires_auth_returns_friendly_error():
    client = MagicMock()
    client.get.side_effect = AuthRequiredError("login needed")
    tools = _tools(client)
    out = tools["get_comps"]("A", "5")
    assert "error" in out
    assert "login" in out["error"].lower()


def test_search_lots_semantic_uses_embed_query():
    client = MagicMock()
    client.edge_fn.return_value = {"ids": ["A:5", "A:6"]}
    client.get.side_effect = [
        [
            {
                "auction_safe_id": "A",
                "item_id": "5",
                "title": "drill",
                "detail_url": "u5",
            },
            {
                "auction_safe_id": "A",
                "item_id": "6",
                "title": "driver",
                "detail_url": "u6",
            },
        ],  # lots
        [],  # enrichment
    ]
    tools = _tools(client)
    out = tools["search_lots"]("drill", semantic=True, limit=10)
    client.edge_fn.assert_called_once()
    assert [r["item_id"] for r in out["results"]] == ["5", "6"]


def test_search_lots_semantic_falls_back_to_keyword_when_embed_query_unavailable():
    client = MagicMock()
    client.edge_fn.side_effect = RuntimeError("404 not deployed")
    client.get.side_effect = [
        [
            {
                "auction_safe_id": "A",
                "item_id": "7",
                "title": "drill",
                "detail_url": "u7",
            }
        ],  # keyword lots
        [],  # enrichment
    ]
    tools = _tools(client)
    out = tools["search_lots"]("drill", semantic=True, limit=10)
    # fell back to keyword GET against public_active_lots; no error surfaced
    assert "error" not in out
    assert out["results"][0]["item_id"] == "7"
    assert out.get("semantic_fallback") is True


def test_sanitize_ilike_strips_reserved_chars():
    from gooners_mcp.server import _sanitize_ilike

    assert _sanitize_ilike("a,b(c)") == "abc"
    assert _sanitize_ilike("50% *off*") == "50 off"


def test_add_favorite_posts_user_id_and_key():
    client = MagicMock()
    client.user_id = "uid-1"
    tools = _tools(client)
    out = tools["add_favorite"]("A", "5")
    client.post.assert_called_once()
    args, kwargs = client.post.call_args
    assert args[0] == "/rest/v1/favorites"
    assert args[1] == {"user_id": "uid-1", "item_key": "A:5"}
    assert out["ok"] is True


def test_list_auctions_dedupes_by_safe_id():
    client = MagicMock()
    client.get.return_value = [
        {
            "auction_safe_id": "A",
            "auction_title": "Auction A",
            "auction_end_date": "2026-06-20",
        },
        {
            "auction_safe_id": "A",
            "auction_title": "Auction A",
            "auction_end_date": "2026-06-20",
        },
        {
            "auction_safe_id": "B",
            "auction_title": "Auction B",
            "auction_end_date": "2026-06-21",
        },
    ]
    tools = _tools(client)
    out = tools["list_auctions"]()
    assert [a["auction_safe_id"] for a in out["auctions"]] == ["A", "B"]
    assert out["auctions"][0]["title"] == "Auction A"


def test_remove_favorite_deletes_by_item_key():
    client = MagicMock()
    tools = _tools(client)
    out = tools["remove_favorite"]("A", "5")
    client.delete.assert_called_once()
    args, kwargs = client.delete.call_args
    assert args[0] == "/rest/v1/favorites"
    assert args[1] == {"item_key": "eq.A:5"}
    assert out["ok"] is True


def test_add_ignored_posts_to_ignored_table():
    client = MagicMock()
    client.user_id = "uid-9"
    tools = _tools(client)
    out = tools["add_ignored"]("B", "12")
    args, kwargs = client.post.call_args
    assert args[0] == "/rest/v1/ignored"
    assert args[1] == {"user_id": "uid-9", "item_key": "B:12"}
    assert out["ok"] is True


def test_get_category_sold_stats_empty_returns_empty_dict():
    client = MagicMock()
    client.get.return_value = []
    tools = _tools(client)
    out = tools["get_category_sold_stats"]("Nonexistent")
    assert out == {}
