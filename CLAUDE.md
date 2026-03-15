# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

A better browsing UI for Cannon's Auctions (Richmond VA). Scraped auction data served as a React SPA on GitHub Pages.

## Architecture

Two components:
- **Scraper** (`scraper/`): Python script that fetches auction data from Maxanet (Cannon's platform), parses HTML, normalizes categories, outputs JSON to `public/data/`
- **Frontend** (`src/`): Vite + React SPA with masonry grid, category filtering, search, infinite scroll

Data flow: Maxanet HTML API → Python scraper → JSON files in `public/data/` → GitHub Pages → React reads JSON

## Commands

```bash
# Frontend
npm run dev          # Start dev server
npm run build        # Production build to dist/
npm run preview      # Preview production build

# Scraper (requires full auction URL with all query params)
cd scraper
uv run --with requests --with beautifulsoup4 python scrape.py "<auction_url>"
```

## Key Details

- Maxanet API requires session cookies + `X-Requested-With: XMLHttpRequest` header
- The `GetAuctionItems` endpoint returns HTML fragments, not JSON
- The `GetCategories` endpoint returns JSON
- Auction URLs must include all query params (AuctionId, Title, etc.) or Maxanet redirects to homepage
- Category normalization mapping is in `scraper/categories.py`
- GitHub Pages base path: `/james-river-gooners/`
- Never use pip/pip3 — always use uv
