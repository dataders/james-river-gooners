import asyncio
import os

import pytest
from gooners_mcp.client import GoonersClient
from gooners_mcp.config import load_config
from gooners_mcp.server import build_server

pytestmark = pytest.mark.skipif(
    os.environ.get("GOONERS_MCP_LIVE") != "1",
    reason="live smoke test; set GOONERS_MCP_LIVE=1 to run",
)


def _tools():
    cfg = load_config()
    client = GoonersClient(cfg.url, cfg.publishable_key, cfg.email, cfg.password)
    server = build_server(client)
    tool_list = asyncio.run(server.list_tools())
    return {t.name: t.fn for t in tool_list}  # ty: ignore[unresolved-attribute]  # fastmcp Tool.fn (untyped)


def test_list_auctions_returns_some():
    out = _tools()["list_auctions"]()
    assert "auctions" in out and len(out["auctions"]) > 0


def test_keyword_search_returns_results():
    out = _tools()["search_lots"](query="table", limit=5)
    assert "results" in out


def test_semantic_search_returns_results():
    out = _tools()["search_lots"](query="cordless drill", semantic=True, limit=5)
    assert "results" in out  # confirms embed-query is deployed
