# gooners MCP

A local, read-only MCP server that lets Claude browse, search, and research the gooners auction read model — Cannon's, HiBid, and Rasmus auctions in the Richmond VA area — and manage favorites/ignored lists. It is a thin client over the project's existing Supabase backend (PostgREST views + the `embed-query` Edge Function); it never places bids or writes auction data.

---

## Tools

### Public — no login required

| Tool | Description |
|------|-------------|
| `list_auctions()` | List currently active auctions (id, title, end date). |
| `search_lots(query, semantic=False, category=None, max_price=None, auction_safe_id=None, limit=50)` | Search active lots by keyword/filter. Set `semantic=True` for meaning-based search via the `embed-query` Edge Function (falls back to keyword search with `semantic_fallback: true` if unavailable). |
| `get_lot(auction_safe_id, item_id)` | Full detail for one lot, including resale enrichment when identified. |

Every lot result includes a `source_url` — the live lot page on the source platform (Cannon's / HiBid / Rasmus). This is the deep link to bid; v1 does not place bids itself.

### Login required

These tools use the same RLS-gated Supabase views as the web app. They return a friendly error message if `GOONERS_EMAIL` / `GOONERS_PASSWORD` are not set.

| Tool | Description |
|------|-------------|
| `get_comps(auction_safe_id, item_id)` | eBay sold comps + Cannon's similar-lot comps for resale research. |
| `get_category_sold_stats(category)` | Median / range / recency of past sold prices for a category. |
| `list_favorites()` | List item keys the user has favorited. |
| `add_favorite(auction_safe_id, item_id)` | Favorite a lot. |
| `remove_favorite(auction_safe_id, item_id)` | Remove a favorite. |
| `list_ignored()` | List item keys the user marked "not interested". |
| `add_ignored(auction_safe_id, item_id)` | Mark a lot "not interested". |
| `remove_ignored(auction_safe_id, item_id)` | Remove a lot from the "not interested" list. |

---

## Configuration

The MCP server reads from the **repo-root `.env.local`** — the same file the Vite frontend uses. No separate config file is needed.

| Variable | Required | Notes |
|----------|----------|-------|
| `VITE_SUPABASE_URL` or `SUPABASE_URL` | **Yes** | Your Supabase project URL. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` or `SUPABASE_PUBLISHABLE_KEY` | **Yes** | The `sb_publishable_…` key. Browser-safe; relies on row-level security. |
| `GOONERS_EMAIL` | No | gooners account email. Required only for comps, sold stats, and favorites/ignored. |
| `GOONERS_PASSWORD` | No | gooners account password. Required only for login-gated tools. |

> **Note:** The secret key (`sb_secret_…`) is **not** used here. The MCP server authenticates as the user, exactly like the browser does. Never put the secret key in a `VITE_` variable or `.env.local`.

Without `GOONERS_EMAIL` / `GOONERS_PASSWORD`, all public tools (`list_auctions`, `search_lots`, `get_lot`) work normally. Login-gated tools return a descriptive error instead of crashing.

---

## Run / Install

### Local run

```bash
uv run --directory mcp gooners-mcp
```

`uv` resolves dependencies from `mcp/pyproject.toml` automatically. Env is loaded from the repo-root `.env.local`.

### Run the test suite

```bash
cd mcp && uv run --extra dev pytest -v
```

All tests pass without a live Supabase connection. Three live-smoke tests are skipped by default; run them with a real `.env.local`:

```bash
GOONERS_MCP_LIVE=1 uv run --extra dev pytest tests/test_live_smoke.py -v
```

### Register with Claude

Add the following to your `~/.claude.json` under `mcpServers` (replace the path with the real absolute path to this repo's `mcp/` directory):

```json
{
  "mcpServers": {
    "gooners": {
      "command": "uv",
      "args": ["run", "--directory", "/ABSOLUTE/PATH/TO/repo/mcp", "gooners-mcp"]
    }
  }
}
```

Env vars are loaded automatically from the repo-root `.env.local` at startup — no `env` block needed in the registration.

---

## Not in v1

Placing/checking bids and drafting Facebook Marketplace listings are deferred to v2 (tracked in [GitHub issue #280](https://github.com/dataders/james-river-gooners/issues/280)); the backends exist but are not wrapped yet.
