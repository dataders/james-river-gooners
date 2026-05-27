# Auction Refresh, Archive, MotherDuck, and Favorites Design

## Problem

The checked-in auction data is stale. The current static site loads every auction listed in
`public/data/manifest.json`, and all current Parquet files were last scraped on 2026-03-16.
Those auctions closed in March and April 2026, so the default UI is showing old data as if it
were current.

The project needs four related improvements:

- Refresh active auction data.
- Preserve closed auctions without cluttering the default browsing view.
- Append listing snapshots to MotherDuck so bid and price changes can be analyzed over time.
- Let users star favorite items with browser-cookie persistence.

## Current State

The scraper writes static Parquet files under `public/data/items/{auctionSafeId}.parquet`.
`public/data/manifest.json` is currently a flat array of safe IDs. The React app reads the
manifest, downloads every listed Parquet file, builds auction metadata from row fields, and
then applies locality, range, search, auction, and category filters in memory.

Each item row already contains the fields needed for archive and snapshot basics:

- `id`
- `lotNumber`
- `title`
- `description`
- `currentBid`
- `totalBids`
- `endDate`
- `images`
- `category`
- `rawCategory`
- `detailUrl`
- `auctionId`
- `auctionSafeId`
- `auctionTitle`
- `auctionEndDate`
- `scrapedAt`

## Goals

Default browsing should show only active auctions. Closed auctions should remain browsable
behind an Archived toggle, not disappear from the project. Snapshot storage should be
optional during scraping and must never expose the MotherDuck token to the browser. Favorite
items should survive page reloads using a browser cookie.

## Non-Goals

This project will not make MotherDuck the live frontend data source. GitHub Pages has no
backend, and the browser must not receive a MotherDuck token. This project will not build
account-based favorite sync or notifications.

## Data And Archive Design

Keep `public/data/manifest.json` as the active browsing boundary, but change it from a flat
ID array to an object:

```json
{
  "auctions": [
    {
      "safeId": "abc",
      "title": "Auction title",
      "endDate": "2026-06-01T17:00:00Z",
      "scrapedAt": "2026-05-27T12:00:00Z",
      "itemCount": 123,
      "itemsPath": "data/items/abc.parquet"
    }
  ]
}
```

Add `public/data/archive-manifest.json` with the same shape. It lists closed auctions and
points at archived Parquet files:

```json
{
  "auctions": [
    {
      "safeId": "old",
      "title": "Closed auction",
      "endDate": "2026-03-18T20:26:00Z",
      "scrapedAt": "2026-03-16T16:51:25Z",
      "itemCount": 827,
      "itemsPath": "data/archive/items/old.parquet"
    }
  ]
}
```

The active manifest remains the default UI source. The archive manifest is fetched only when
the user enables archived browsing. This keeps the initial page load fast while preserving
closed auctions for later inspection.

For backwards compatibility during rollout, the frontend loader should accept both the old
flat array format and the new object format. Once the new manifests are committed and working,
the flat-array compatibility can stay as a low-cost guard.

## Scraper Refresh Flow

`scraper/auction_urls.txt` remains a supported input list, but it should no longer be the
only source of current auctions. Cannon's public auction page calls
`/Public/Auction/GetAuctions` with `pageNumber`, `filter`, `auctionTypeFilter`, `pageSize`,
and `viewType` parameters. That endpoint returns current auction card HTML containing the
full `/Public/Auction/AuctionItems?...` URLs needed by the existing scraper.

Refresh does this:

1. Discover current auction item URLs from `/Public/Auction/GetAuctions`.
2. Merge discovered URLs with any manually configured URLs from `scraper/auction_urls.txt`.
3. Scrape each URL.
4. Write a fresh Parquet file with embedded auction metadata.
5. Classify the auction as active or archived by parsing `auctionEndDate`.
6. Place active files under `public/data/items/`.
7. Place archived files under `public/data/archive/items/`.
8. Rebuild `manifest.json` from active files.
9. Rebuild `archive-manifest.json` from archived files.

Closed auctions are not deleted. If an auction moves from active to archived, its Parquet file
is moved out of the active item path so default browsing no longer downloads it.

If a configured auction fails to scrape because the upstream URL is no longer valid, the
refresh command should report the failure and leave the previous archived Parquet file in
place if one exists. It should not silently delete historical data.

## Browser Automation Position

Do not use Vercel `agent-browser` as the primary scraper for the first implementation. The
current Maxanet flow exposes the auction-list and auction-item data through HTTP endpoints
that can be called deterministically from Python in GitHub Actions. Browser automation adds a
Chrome/CDP runtime, more moving parts, and higher scheduled-run flake risk without solving the
current blocker.

Keep browser automation as a fallback/debug option for these cases:

- Maxanet changes the discovery flow so `/Public/Auction/GetAuctions` no longer returns full
  item URLs.
- Session state, cookies, or anti-bot behavior cannot be reproduced with `requests`.
- A one-off investigation needs browser network capture to discover a new endpoint.

The production scraper should stay HTTP-first until one of those cases is proven.

## MotherDuck Snapshot Design

MotherDuck is an optional append step after a successful scrape. Static Parquet remains the
frontend source of truth. The MotherDuck write path is enabled only when a token is available
and an explicit flag or environment variable is set.

Use a single append-only table named `listing_snapshots`:

```sql
create table if not exists listing_snapshots (
  auction_id text,
  auction_safe_id text,
  item_id text,
  lot_number bigint,
  snapshot_at timestamptz,
  auction_title text,
  auction_end_at timestamptz,
  item_end_at timestamptz,
  title text,
  description text,
  current_bid decimal(12, 2),
  total_bids integer,
  category text,
  raw_category text,
  detail_url text,
  images text,
  source_url text,
  ingested_at timestamptz default now(),
  primary key (auction_id, item_id, snapshot_at)
)
```

Price history is queried by `(auction_id, item_id)` ordered by `snapshot_at`. The first
implementation can use `duckdb==1.5.2`, because connectivity was verified with that version
and newer local resolution was rejected by MotherDuck. The smoke test is non-mutating:

```bash
uv run --with 'duckdb==1.5.2' python3 -c "import duckdb; con=duckdb.connect('md:'); print('motherduck_connectivity=ok' if con.execute('select 1').fetchone()[0] == 1 else 'motherduck_connectivity=unexpected')"
```

The scraper must never print token values or include them in committed config.

## Frontend Archive Behavior

The app loads active auctions on startup. Add an Archived toggle near the existing auction
filter controls. When disabled, only active auctions and items are available to the normal
filter pipeline. When enabled, the app fetches `archive-manifest.json`, downloads archived
Parquet files, merges them with active data, and shows closed auctions with the same search,
range, locality, category, grid, and detail interactions.

Closed cards keep using the existing `timeRemaining()` behavior, which returns `Ended` for
past dates. Archive filtering should happen before category counts and range controls so the
visible controls match the loaded item set.

## Favorites Design

Favorites are separate from auction data loading. Add a `useFavorites` hook that stores a
compact list of stable item keys in a cookie named `gooners-favorites`.

The stable key is:

```text
{auctionSafeId}:{id}
```

Cookie value:

```json
["auctionSafeId:itemId", "auctionSafeId:itemId"]
```

The cookie should be encoded with `encodeURIComponent`, scoped to `path=/`, set with
`SameSite=Lax`, and use a one-year max age. It should store IDs only, not full item objects,
to stay within cookie size limits.

Add star controls to item cards and item detail. The card star must stop click propagation so
starring an item does not open the detail modal. Favorited items should render with an active
star state wherever the item appears, including archived browsing.

## Error Handling

Data loading should keep active browsing resilient. If active manifest loading fails, show the
existing error state. If archive manifest loading fails after the Archived toggle is enabled,
show an archive-specific message and keep active items visible.

MotherDuck append failures should fail the scraper command when snapshotting is explicitly
enabled. If MotherDuck is not enabled, scraper output should be unchanged.

Cookie parsing failures should reset favorites to an empty list and overwrite the malformed
cookie on the next favorite change.

## Testing

Add focused tests around pure behavior first:

- manifest parsing accepts old flat arrays and new object manifests.
- archive classification separates active and closed auctions.
- favorite cookie load/save/toggle works and stores only item keys.
- filter counts and item lists change when archived data is included.

Then add component coverage for the star button to verify it toggles favorites without opening
the detail modal.

Run these checks before implementation is considered complete:

```bash
npm run lint
npm run build
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml python3 scraper/rescrape_all.py
```

The MotherDuck smoke test should run only when the environment has a token.

## Rollout

Implement in small pieces:

1. Manifest builder and archive classification.
2. Frontend manifest loader compatibility.
3. Archived toggle with lazy archive loading.
4. Favorite cookie hook and star UI.
5. Optional MotherDuck append path.
6. Documentation updates for Parquet, archive, and MotherDuck commands.
