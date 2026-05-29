# CLAUDE.md

Better browsing UI for Cannon's Auctions (Richmond VA). Scraper fetches Maxanet data → Parquet files → React SPA on GitHub Pages.

## Architecture

**Scraper** (`scraper/`) — Python scripts: discover auctions, fetch Maxanet HTML fragments, normalize categories, write Parquet to `public/data/`.

**Frontend** (`src/`) — Vite + React 19 SPA. Reads Parquet in-browser via `parquet-wasm` + `apache-arrow`. Masonry grid, filtering (auction/category/price/search), favorites, infinite scroll, dark mode.

**Data layout:**
- Active: `public/data/manifest.json` + `public/data/items/*.parquet`
- Archived: `public/data/archive-manifest.json` + `public/data/archive/items/*.parquet` (loaded only when archive toggle is on)

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
```

## Key Constraints

- Never use pip/pip3 — always `uv`
- Auction URLs must include all query params (`AuctionId`, `Title`, etc.) — Maxanet redirects to homepage without them
- Maxanet API needs session cookies + `X-Requested-With: XMLHttpRequest`; `GetAuctionItems` returns HTML fragments (not JSON); `GetCategories` returns JSON
- `rescrape_all.py` auto-discovers auctions; `scraper/auction_urls.txt` is a manual fallback only
- Category normalization: `scraper/categories.py` + `scraper/category_mappings.yml`
- MotherDuck: appends to `listing_snapshots` table; `MOTHERDUCK_TOKEN` must stay out of committed files; use `duckdb==1.5.2`
- GitHub Pages base path: `/james-river-gooners/` (vite.config sets `base: '/'` for local dev)
- Arrow `BigInt` fields (`lotNumber`, `totalBids`, `currentBid`) must be converted to `Number` after Parquet deserialization
