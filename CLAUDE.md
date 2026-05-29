# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A better browsing UI for Cannon's Auctions (Richmond VA). Scraped auction data served as a React SPA on GitHub Pages.

## Architecture

Two components:
- **Scraper** (`scraper/`): Python scripts that discover current Cannon's auctions, fetch Maxanet item HTML, normalize categories, and write Parquet under `public/data/`
- **Frontend** (`src/`): Vite + React SPA with masonry grid, auction/category/range/search filtering, archived browsing, favorites, and infinite scroll

Data flow: Maxanet HTML API -> Python scraper -> Parquet files + manifests in `public/data/` -> GitHub Pages -> React reads manifests and Parquet in the browser.

Active auctions live in `public/data/items/` and `public/data/manifest.json`. Closed/stale auctions live in `public/data/archive/items/` and `public/data/archive-manifest.json`; the frontend loads them only when the Archived auctions toggle is enabled.

## Commands

```bash
# Frontend
npm run dev          # Start dev server
npm run build        # Production build to dist/
npm run preview      # Preview production build

# Scraper (requires full auction URL with all query params)
cd scraper
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml python3 rescrape_all.py
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml python3 scrape.py "<auction_url>"

# Optional MotherDuck snapshot append
GOONERS_MOTHERDUCK_SNAPSHOTS=1 uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml --with 'duckdb==1.5.2' python3 scrape.py "<auction_url>"
```

## Key Details

- Maxanet API requires session cookies + `X-Requested-With: XMLHttpRequest` header
- The `GetAuctionItems` endpoint returns HTML fragments, not JSON
- The `GetCategories` endpoint returns JSON
- Auction URLs must include all query params (AuctionId, Title, etc.) or Maxanet redirects to homepage
- `scraper/rescrape_all.py` discovers current auctions first; `scraper/auction_urls.txt` is comments-only by default and should be used only as a manual fallback
- MotherDuck snapshots are optional and append to `listing_snapshots` only when `GOONERS_MOTHERDUCK_SNAPSHOTS=1` or `--motherduck` is set; keep `MOTHERDUCK_TOKEN` in the environment, never in committed files
- Use `duckdb==1.5.2` for MotherDuck writes
- Category normalization mapping is in `scraper/categories.py`
- GitHub Pages base path: `/james-river-gooners/`
- Live site URL: https://gooners.anders.omg.lol/
- Never use pip/pip3 — always use uv
