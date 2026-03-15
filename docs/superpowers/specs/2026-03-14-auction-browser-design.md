# Cannon's Auction Browser — Design Spec

## Problem

The Cannon's Auctions website (Maxanet platform) has a frustrating browsing experience:
- Paginated lists (no infinite scroll), especially painful on mobile
- Single category filter at a time, with hundreds of messy/duplicate categories
- No way to exclude uninteresting categories (coins, jewelry, firearms)
- Poor search functionality

## Solution

A custom React SPA hosted on GitHub Pages that presents scraped auction data with better UX: masonry grid, infinite scroll, multi-category include/exclude filtering, and persistent preferences.

## Architecture

```
Maxanet HTML API ──▶ Python Scraper ──▶ JSON files ──▶ git push ──▶ GitHub Pages
                                         (public/data/)              ──▶ React SPA reads JSON
```

### Two components:

1. **Python scraper** (`scraper/`) — fetches and parses Maxanet data
2. **React SPA** (`src/`) — Vite + React static site

## Scraper (`scraper/`)

### How it works

Maxanet requires session cookies and an `X-Requested-With: XMLHttpRequest` header. The scraper:

1. `GET /Public/Auction/AuctionItems?AuctionId=...` to establish a session
2. `GET /Public/Lookup/GetCategories?AuctionId=...` → JSON array of `{Text, Value}` (category name/ID)
3. `GET /Public/Auction/GetAuctionItems?aucId=...&pageNumber=N&pageSize=...&viewType=2&ShowFilter=all&SortBy=ordernumber_asc` with `X-Requested-With: XMLHttpRequest` → HTML fragments
4. Parse HTML with BeautifulSoup, paginate through all pages
5. Normalize categories into ~15 clean groups via a mapping dict
6. Output JSON to `public/data/`

### Data model

`public/data/auctions.json`:
```json
[
  {
    "id": "MmwrCfPOyubVzrgFK3d1gQ==",
    "title": "03/18/26: Gallery Consignments | Online Estate Auction",
    "endDate": "2026-03-18T17:00:00",
    "totalItems": 827,
    "scrapedAt": "2026-03-14T12:00:00Z"
  }
]
```

Item files use a sanitized auction ID as filename (base64 URL-safe: replace `+` with `-`, `/` with `_`, strip `=`).

`public/data/items/{sanitizedAuctionId}.json`:
```json
[
  {
    "id": "48875294",
    "lotNumber": 1,
    "title": "C4491",
    "description": "Marlin Glenfield model 20 bolt action rifle...",
    "currentBid": 35,
    "totalBids": 7,
    "endDate": "2026-03-18T17:00:00",
    "images": ["https://s3.amazonaws.com/prod.maxanet.auction/Can399/...350x350.jpg"],
    "category": "Firearms",
    "rawCategory": "Firearms - Rifles",
    "detailUrl": "https://bid.cannonsauctions.com/Public/Auction/AuctionItemDetail?..."
  }
]
```

### Category normalization

Map Maxanet's hundreds of messy categories into clean groups:

| Group | Example raw categories |
|-------|----------------------|
| Furniture | Furniture, Tables, Chairs, Bedroom |
| Tools & Hardware | Tools, Hardware, Power Tools |
| Electronics | Cameras, Audio, Computers, Phones |
| Vehicles | Cars, Trucks, Trailers, Campers, Boats |
| Art & Decor | Artwork, Sculptures, Decorative Accessories |
| Coins & Currency | Coins, Gold, Silver, Currency |
| Jewelry | Jewelry, Rings, Watches |
| Firearms | Guns, Ammunition, Firearms |
| China & Glass | China, Ceramics, Crystal, Glassware |
| Books & Ephemera | Books, Ephemera, Records |
| Rugs & Textiles | Rugs, Linens, Textiles |
| Lawn & Garden | Lawn, Garden, Outdoor |
| Kitchen | Kitchenware, Appliances |
| Sporting Goods | Sports, Fishing, Camping |
| Other | Anything unmapped |

### Auction discovery

The scraper can be pointed at a specific auction URL, or it can fetch the current/upcoming auction list from `https://bid.cannonsauctions.com/Public` (the homepage lists active auctions dynamically). For MVP, pass an auction URL manually. Future: auto-discover active auctions.

### GitHub Action

`.github/workflows/scrape.yml`:
- Trigger: `workflow_dispatch` (manual) with required auction URL input
- Optional cron: `0 */6 * * *` (every 6 hours, can enable later)
- Steps: checkout → setup Python → pip install deps → run scraper → commit + push JSON to main
- Data commits go to `main` branch (acceptable for MVP data volume; can move to a `data` branch if repo bloat becomes an issue)

## Frontend (`src/`)

### Tech stack

- Vite + React
- Plain CSS (index.css) — keep it simple for MVP
- `react-masonry-css` for masonry layout
- No routing needed for MVP (single page)

### Components

```
App
├── AuctionPicker       — dropdown: which auction to view
├── SearchBar           — text search across titles/descriptions
├── FilterBar
│   ├── IncludeTabs     — pill buttons: Tools, Electronics, Vehicles, All
│   └── ExcludeChips    — red chips for hidden sub-categories within included groups
├── ItemGrid            — masonry layout, infinite scroll
│   └── ItemCard[]      — image, title, bid, bids count, time left
└── DataFreshness       — "Data from 2h ago" indicator (reads scrapedAt from auctions.json)
```

### FilterBar behavior

**Include tabs** (top row):
- Pill buttons for each of the ~15 normalized category groups
- "All" is a shortcut that selects every category — tapping a specific category while "All" is active deselects "All" and selects only that category
- Tapping "All" again clears individual selections and shows everything
- Multi-select among individual categories: tap to toggle, selected tabs highlighted green
- Only items whose `category` matches a selected tab are shown

**Exclude chips** (below, contextual):
- Shows `rawCategory` values found within the currently included groups
- Example: if "Electronics" is included, chips appear for "Cameras", "Audio", "Computers", "Phones"
- Tap a chip to exclude that raw category (turns red with ✕)
- Excluded list persists in localStorage

**Default preset** (first visit):
- Include: All
- Exclude: Coins & Currency, Jewelry, Firearms (these are top-level normalized groups, excluded via the include tabs being deselected — effectively "All minus three")

**Zero-image items**: Show a placeholder gray box with the lot title centered.

### ItemCard

- Thumbnail image (first image from array, 350x350 from S3)
- Title
- Current bid (green) + bid count
- Time remaining (calculated client-side from endDate)
- Tap → opens Cannon's detail page in new tab

### Infinite scroll

- Load all items into memory (JSON is ~1-2MB for 800 items)
- Render in batches of 50 with intersection observer
- Filter/search operates on in-memory array, re-renders grid

### localStorage persistence

Key: `gooners-preferences`
```json
{
  "includedCategories": ["Tools & Hardware", "Electronics", "Vehicles"],
  "excludedCategories": ["Coins & Currency", "Jewelry", "Firearms"],
  "lastAuctionId": "MmwrCfPOyubVzrgFK3d1gQ=="
}
```

## File structure

```
james-river-gooners/
├── .github/workflows/scrape.yml
├── scraper/
│   ├── scrape.py
│   ├── categories.py          # category normalization mapping
│   └── requirements.txt       # requests, beautifulsoup4
├── public/
│   └── data/                  # scraped JSON (git-tracked)
│       ├── auctions.json
│       └── items/
│           └── {auctionId}.json
├── src/
│   ├── App.jsx
│   ├── components/
│   │   ├── AuctionPicker.jsx
│   │   ├── SearchBar.jsx
│   │   ├── FilterBar.jsx
│   │   ├── ItemGrid.jsx
│   │   └── ItemCard.jsx
│   ├── hooks/
│   │   ├── useAuctionData.js
│   │   └── usePreferences.js
│   ├── utils/
│   │   └── filters.js
│   ├── index.css
│   └── main.jsx
├── index.html
├── vite.config.js
├── package.json
└── CLAUDE.md
```

## Development data

Run the scraper locally first to generate real JSON data in `public/data/`. This data is committed to git so the frontend always has something to render, even during development. No separate fixture data needed — the scraped data IS the fixture.

## Deployment

- GitHub Pages from `gh-pages` branch
- `npm run build` → Vite outputs to `dist/`
- `gh-pages -d dist` deploys
- `vite.config.js` must set `base: '/james-river-gooners/'` for correct asset paths
- JSON data files served from `public/data/` (copied to dist by Vite)

## Verification

1. **Scraper**: `cd scraper && python scrape.py` — should output JSON files to `public/data/`
2. **Dev server**: `npm run dev` — should render masonry grid with sample/scraped data
3. **Filtering**: Toggle category tabs, verify items filter correctly
4. **Infinite scroll**: Scroll down, verify more items load
5. **Mobile**: Check responsive layout (2 columns on mobile viewport)
6. **Preferences**: Refresh page, verify filter state persists
7. **Links**: Click an item card, verify it opens Cannon's detail page

## Future enhancements (not in MVP)

- Saved preferences / notification when matching items appear
- "Value score" — estimated worth vs current bid
- PubNub integration for live bid updates
- Image lazy loading with blur-up placeholder
- Bid history charts per item
