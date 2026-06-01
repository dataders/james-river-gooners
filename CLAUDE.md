# CLAUDE.md

Better browsing UI for Cannon's Auctions (Richmond VA). Scraper fetches Maxanet data → Parquet files → React SPA on GitHub Pages.

## Architecture

**Scraper** (`scraper/`) — Python scripts: discover auctions, fetch Maxanet HTML fragments, normalize categories, write Parquet to `public/data/`.

**Frontend** (`src/`) — Vite + React 19 SPA. Reads the per-auction NDJSON sidecars in-browser (one `fetch` per auction via `src/hooks/useAuctionData.js`); no Parquet/Arrow runs client-side. Masonry grid, filtering (auction/category/price/search), keyword + CLIP semantic search, favorites, infinite scroll, dark mode.

**Data layout** (the browser reads NDJSON; Parquet is written alongside it as the warehouse/manifest source, not served to the SPA):
- Active: `public/data/manifest.json` + `public/data/items/{safeId}.ndjson` (+ `.parquet`, `.embeddings`)
- Archived: `public/data/archive-manifest.json` + `public/data/archive/items/{safeId}.ndjson` (loaded only when archive toggle is on)
- eBay comps: `public/data/ebay-comps/{safeId}.json` (loaded per visible auction; 404-tolerant)

## Commands

```bash
# Frontend
npm run dev       # dev server
npm run build     # production build → dist/
npm run lint      # eslint

# Scraper — run from scraper/
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml python3 rescrape_all.py
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml python3 scrape.py "<full_auction_url>"

# Optional MotherDuck snapshot (requires MOTHERDUCK_TOKEN env var)
GOONERS_MOTHERDUCK_SNAPSHOTS=1 uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml --with 'duckdb==1.5.2' python3 scrape.py "<full_auction_url>"

# Optional CLIP embeddings (first run downloads ~350 MB of model weights)
GOONERS_EMBEDDINGS=1 uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml --with sentence-transformers --with pillow python3 scrape.py "<full_auction_url>"
```

## Key Constraints

- Never use pip/pip3 — always `uv`
- Auction URLs must include all query params (`AuctionId`, `Title`, etc.) — Maxanet redirects to homepage without them
- Maxanet API needs session cookies + `X-Requested-With: XMLHttpRequest`; `GetAuctionItems` returns HTML fragments (not JSON); `GetCategories` returns JSON
- `rescrape_all.py` auto-discovers auctions; `scraper/auction_urls.txt` is a manual fallback only
- Category normalization: `scraper/categories.py` + `scraper/category_mappings.yml`
- MotherDuck: appends to `listing_snapshots` table in `my_db`; both tokens must stay out of committed files; use `duckdb==1.5.2`
  - `MOTHERDUCK_TOKEN` — read/write PAT; used by scraper and Claude Code MCP server
  - `MOTHERDUCK_READ_TOKEN` — read-scaling token; safe to expose to browsers/CDN; used in GitHub Actions as `MOTHERDUCK_READ_SCALING_TOKEN` secret for eBay comps export
- CLIP embeddings: `GOONERS_EMBEDDINGS=1` triggers `embed.py` after each scrape; writes `{safe_id}.embeddings` binary alongside `.ndjson`; manifest gains `embeddingsPath`; requires `sentence-transformers` + `pillow`; model cached in `~/.cache/huggingface` after first download
- Served from a custom domain (`public/CNAME` → `cannonsbrowser.com`), so vite uses `base: '/'` (root) in all environments
- The browser reads NDJSON, so numeric fields (`lotNumber`, `totalBids`, `currentBid`) arrive as plain JS numbers — no Arrow/BigInt conversion needed. (The old `parquet-wasm` loader was removed in #52.)
- Network reads from the read model go through `src/utils/net.js` (`fetchWithRetry` / `fetchJsonWithRetry` / `fetchTextWithRetry`): retries 5xx + network errors with exponential backoff, returns 4xx as-is so the comps loader can treat 404 as "no comps yet"
- A top-level `ErrorBoundary` (`src/components/ErrorBoundary.jsx`, wired in `main.jsx`) keeps a render error in one item/component from blanking the whole page

## CI / PR Monitoring

**At the start of every session:** immediately call `mcp__github__list_pull_requests` for `dataders/james-river-gooners` (state: open) and call `mcp__github__subscribe_pr_activity` for every open PR. Do this before the user asks. Subscriptions do not persist across sessions — re-subscribing each session is mandatory.

After pushing a branch and opening a PR, always call `mcp__github__subscribe_pr_activity` for that PR, then actively follow through on every `<github-webhook-activity>` event that arrives:
- CI failure → diagnose, fix, push, re-check until green
- Review comment → address or ask the user if ambiguous
- Do NOT just say "I'm watching" and go quiet — each event requires a visible response and action
