# Data Architecture

This document is the source of truth for how data moves through james-river-gooners:
how it is scraped, where it is stored, how the browser reads it, and how the
backend will migrate from MotherDuck to Supabase without rewriting the app.

## The three layers

Every piece of data belongs to exactly one of three layers. Keeping them
separate is what keeps the system understandable.

```
        INGEST                  WAREHOUSE                   READ MODEL              BROWSER
        (scrapers)              (system of record)          (static, on Pages)

Maxanet ─► scrape.py     ──┐                            ┌─► items/*.parquet   ──┐
                           ├─► [SnapshotSink] ──────────┤   + manifest.json     ├─► React SPA
eBay    ─► ebay_comps.py ──┘   MotherDuck → Supabase    └─► ebay-comps/*.json ──┘   (one loader
                               (OPTIONAL mirror, both)      + comps manifest         convention)
```

### 1. Ingest (`scraper/`)

Scrapers parse external sources into normalized records. They decide *what* the
data is, never *where* it is stored.

- `discover.py` — finds the current auction URLs from Maxanet.
- `scrape.py` — parses Maxanet HTML fragments into item records.
- `ebay_comps.py` — fetches eBay sold comps for items that need them.

### 2. Read model (`public/data/`)

The static files the browser downloads. This is the **only** thing the frontend
reads. It must work with **zero backend configuration** — GitHub Pages has no
server and the browser must never receive a warehouse token.

Convention for every dataset: **one manifest + per-auction data files**, loaded
through one shared fetch utility (`src/utils/net.js`, used by the data hooks).

| Dataset | Manifest | Per-auction file the browser reads | Sidecars on disk |
| --- | --- | --- | --- |
| Active listings | `data/manifest.json` | `data/items/{safeId}.ndjson` | `.parquet`, `.embeddings` |
| Archived listings | `data/archive-manifest.json` | `data/archive/items/{safeId}.ndjson` | `.parquet`, `.embeddings` |
| eBay comps | `data/ebay-comps/manifest.json` *(target)* | `data/ebay-comps/{safeId}.json` | — |

**What the browser actually reads.** The SPA fetches the **NDJSON** sidecar for
each auction (`useAuctionData.js` → `net.js`) and the comps JSON for each visible
auction. There is no Parquet or Arrow in the browser — the `parquet-wasm` loader
was removed in #52. NDJSON keeps `images` as a real array and yields plain JS
numbers (no BigInt conversion).

**Why Parquet still exists.** Each scrape writes `{safeId}.parquet` next to the
NDJSON. It is *not* served to the SPA; it is the source the scraper reads back to
build manifest metadata (`rescrape_all.py`) and the columnar artifact mirrored to
the warehouse. Listings stay columnar (large, flat, tabular) for analytics; comps
are JSON (small, nested match arrays). The unifying principle is one *convention*
(manifest + shared loader), not one *format*.

### 3. Warehouse (system of record / analytics)

An **optional**, append-only store of historical snapshots, used for analytics
and as the durable record behind the read model. It is never on the critical
path for serving the site, and it is the **same** for both listings and comps.

- Today: **MotherDuck** (`md:`), enabled only when `MOTHERDUCK_TOKEN` is set.
- Tomorrow: **Supabase / Postgres**, selected by config.

The warehouse is reached only through the `SnapshotSink` interface in
`scraper/warehouse.py`. Nothing else imports `duckdb` directly. **This is the
seam the Supabase migration turns on.**

## Source of truth, per concern

| Concern | Source of truth |
| --- | --- |
| Current listings the site shows | Read model (static Parquet) |
| Historical bid/price snapshots | Warehouse |
| eBay comps the site shows | Read model (static JSON) |
| Historical comp snapshots | Warehouse |
| User favorites | Browser `localStorage` |

## Data flow, step by step

A scheduled GitHub Action (`.github/workflows/scrape.yml`) runs hourly:

1. `rescrape_all.py` discovers current auctions (falls back to
   `auction_urls.txt`).
2. For each auction, `scrape.py` parses items and writes
   `data/items/{safeId}.parquet`. It skips the write when no bids changed.
3. If a warehouse is configured, the same records are appended to the
   warehouse through `SnapshotSink` (optional mirror).
4. Closed/stale auctions are moved to `data/archive/items/`.
5. Manifests are rebuilt from the Parquet files on disk.
6. `ebay_comps.py` refreshes a rate-limited subset of eBay comps and updates
   `data/ebay-comps/*.json`; the same records optionally mirror to the warehouse.
7. The Action commits `public/data/` and pushes.

The browser then reads only the static read model: manifest → Parquet/JSON.

## Conventions

- **No `duckdb` imports outside `scraper/warehouse.py`.** All warehouse access
  goes through `SnapshotSink`.
- **Auction-level metadata lives in the manifest**, item-level data lives in
  the per-auction files. (See "Known debt" — this normalization is in progress.)
- **Date parsing is centralized** in `scraper/dates.py`. Do not copy
  `DATE_PATTERNS` into other modules.
- **The browser never sees a warehouse token.** Anything requiring a token runs
  only in the scraper / CI.

## Supabase migration path

Because all warehouse access is behind `SnapshotSink`, migrating off MotherDuck
is additive, not a rewrite:

1. Implement `SupabaseSink` in `scraper/warehouse.py` (append to Postgres tables
   `auctions`, `listing_snapshots`, `comp_snapshots` — these mirror the
   normalized read model 1:1).
2. Set `GOONERS_WAREHOUSE=supabase` plus Supabase credentials in CI secrets.
3. Optionally keep `MotherDuckSink` as a second analytics mirror, or retire it.
4. The static read model continues to power the public site unchanged.
5. *Future, optional:* dynamic features that a static site can't serve (favorites
   sync, accounts) can read Supabase live. The public browse stays static.

## Known debt / in-progress normalization

These are tracked targets, not yet fully implemented:

- **Auction metadata is still embedded per-row** in every listing file (NDJSON
  *and* Parquet) *and* derived into the manifest *and* rebuilt in the frontend
  (`useAuctionData.js` reconstructs the auction list from row fields rather than
  reading the manifest). The manifest should be the single source of
  auction-level facts; rows should carry only `auctionSafeId` as a foreign key.
  (Refactor phase 4.)
- **`data/ebay-comps/` has no manifest.** The frontend guesses URLs by safeId
  and tolerates 404s. Target: add a comps manifest. (Refactor phase 4.)

### Resolved

- ~~eBay comps require a warehouse to be produced.~~ Comps now accumulate
  directly in the per-auction JSON via `ebay_comps.py fetch-direct`: each run
  refreshes a rate-limited subset, merges results into the existing files, and
  records every attempt under `attempts` so already-tried items are not
  re-fetched until they go stale. MotherDuck is an optional mirror behind
  `SnapshotSink`, enabled only when `GOONERS_MOTHERDUCK_SNAPSHOTS` is set. The
  read-model files are schema version 2 (`source: "scraper"`). (Phase 3.)

## eBay comps request budget

The SoldComps API is metered (currently **2,000 requests/month**, where one
request == one search query). The whole pipeline shares that single ceiling —
both the hourly `scrape.yml` refresh and the manual `ebay-comps.yml` run draw
from the same pool.

Rather than tracking spend in a separate counter file (which two concurrent
Actions runs could race on), usage is **derived from the read model itself**:
each item's `attempts` record carries a `queries` count, and
`requests_used_in_month()` sums those for the current UTC month across all
`public/data/ebay-comps/*.json` files. Because every run commits the read model,
the next run sees the updated total.

`ebay_comps.py fetch-direct` knobs that govern this:

- `--monthly-budget N` (default 2000) — hard stop once the month's requests reach `N`. `0` disables.
- daily pacing (on by default; `--no-daily-pacing` to disable) — spreads the remaining
  budget evenly across the remaining days of the month, so a churning catalog gets
  coverage all month instead of exhausting the budget in the first few days.
- `--max-queries N` — an additional per-run request cap (`0` = none).
- `--skip-attempted` — spend only on items never tried before (backfill); without it,
  items refresh once they pass `--stale-hours`.
- Candidates are processed **soonest-ending auction first**, so budget lands on lots
  that are still biddable.
