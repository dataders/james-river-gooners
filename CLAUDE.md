# CLAUDE.md

Better browsing UI for Cannon's Auctions (Richmond VA). Scraper fetches Maxanet data → Parquet files → React SPA on GitHub Pages.

## Architecture

**Scraper** (`scraper/`) — Python scripts: discover auctions, fetch source data, normalize categories, write Parquet to `public/data/`. Three sources, one shared item schema: Maxanet/Cannon's (`scrape.py`), HiBid (`scrape_hibid.py` + `hibid_sources.yml`), and Rasmus (`scrape_rasmus.py` + `rasmus_sources.yml`). `rescrape_all.py` discovers + scrapes all three (`--source maxanet|hibid|rasmus` to limit).

**Rasmus source** (`scrape_rasmus.py`) — Rasmus runs on the auction-engine.com platform backed by a public Firebase Firestore project (`dark-shade`). Lots live in the world-readable top-level `items` collection tagged `origin_sid: rasmus_auctions_appspot_com`; the scraper reads them via the Firestore REST `:runQuery` API (no key secret — it's the browser-side Firebase web key). Rasmus sells nationwide, so discovery is Richmond-first: a cheap projected query (`aid` + `time_end`) finds active auctions, then each auction's prerendered `<title>`/`og:title` is checked against `rasmus_sources.yml` `location_keywords` (the city only exists in the page title — the per-item `location` field is a warehouse bin, not queryable). Only Richmond-area, non-real-estate auctions get their lots fully pulled. `uniqueBidders` comes free from each lot's `bidders_by_uid`; `totalBids` has no truer source than that distinct-bidder count.

**Frontend** (`src/`) — Vite + React 19 SPA. Reads the per-auction NDJSON sidecars in-browser (one `fetch` per auction via `src/hooks/useAuctionData.js`); no Parquet/Arrow runs client-side. Masonry grid, filtering (auction/category/price/search), keyword + CLIP semantic search, favorites, infinite scroll, dark mode.

**Auth + cloud favorites** (`src/lib/supabase.js`, M2/#91-#93) — Supabase email/password auth. Single browser client in `src/lib/supabase.js` reads `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_…` key, browser-safe given row-level security); `supabase`/`isSupabaseConfigured` are null/false when those env vars are absent so the static site still works offline. `useAuth` exposes the session; `useFavorites(user)` is offline-first — the `gooners-favorites` cookie is the source of truth when logged out, the RLS-protected `favorites` table when logged in (cookie favorites merge up on first login). `useIgnored(user)` is its exact mirror for the "not interested" list (`gooners-ignored` cookie + `ignored` table); ignored items are hidden from the grid by default and surfaced via the **Ignored** toggle. Favorites and ignores are mutually exclusive — `App.jsx` clears one when the other is set (`removeIgnored`/`removeFavorite`). A `SwipeDeck` (Tinder-style) lets users review undecided items one card at a time: swipe/→ favorites, swipe/← ignores, ↓ skips. SQL lives in `supabase/migrations/`. The `sb_secret_…` key (`SUPABASE_SECRET_KEY`) is backend-only — never in a `VITE_` var or the bundle.

**Telemetry** (`src/lib/analytics.js`) — anonymous, cookieless PostHog. Single client mirrors the Supabase pattern: reads `VITE_POSTHOG_KEY` (+ optional `VITE_POSTHOG_HOST`, defaults to US cloud); `isAnalyticsConfigured` is false and all helpers no-op when the key is absent, so the static site runs with no analytics. Init once in `main.jsx`. Privacy posture: `person_profiles: 'identified_only'` (anonymous sessions counted but never get a stored profile), `persistence: 'localStorage'` (no tracking cookies), `respect_dnt`, autocapture + session recording OFF — only explicit `captureEvent()` calls (e.g. `favorite_toggled`) plus pageviews. `useAuth` calls `identifyUser(user.id)` on login and `resetAnalytics()` on logout, so auth vs unauth sessions are distinguishable. The key is a write-only ingestion key (browser-safe); the personal `phx_…` admin key must never reach a `VITE_` var or the bundle.

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
- Served from a custom domain (`public/CNAME` → `gooners.anders.omg.lol`), so vite uses `base: '/'` (root) in all environments
- The browser reads NDJSON, so numeric fields (`lotNumber`, `totalBids`, `currentBid`) arrive as plain JS numbers — no Arrow/BigInt conversion needed. (The old `parquet-wasm` loader was removed in #52.)
- Network reads from the read model go through `src/utils/net.js` (`fetchWithRetry` / `fetchJsonWithRetry` / `fetchTextWithRetry`): retries 5xx + network errors with exponential backoff, returns 4xx as-is so the comps loader can treat 404 as "no comps yet"
- A top-level `ErrorBoundary` (`src/components/ErrorBoundary.jsx`, wired in `main.jsx`) keeps a render error in one item/component from blanking the whole page

## CI / PR Monitoring

**At the start of every session:** immediately call `mcp__github__list_pull_requests` for `dataders/james-river-gooners` (state: open) and call `mcp__github__subscribe_pr_activity` for every open PR. Do this before the user asks. Subscriptions do not persist across sessions — re-subscribing each session is mandatory.

After pushing a branch and opening a PR, always call `mcp__github__subscribe_pr_activity` for that PR, then actively follow through on every `<github-webhook-activity>` event that arrives:
- CI failure → diagnose, fix, push, re-check until green
- Review comment → address or ask the user if ambiguous
- Do NOT just say "I'm watching" and go quiet — each event requires a visible response and action

**Actively watching CI with Monitor:** use the Monitor tool (not just subscribe) to poll CI results after pushing. This version of `gh` does NOT support `--json` on `pr checks` — use plain text output:

```bash
# Watch PR #N until all checks finish, emit each result as it lands
while true; do
  out=$(gh pr checks N --repo dataders/james-river-gooners 2>/dev/null) || { sleep 15; continue; }
  if ! echo "$out" | grep -q "pending"; then
    echo "$out" | awk -F'\t' '{print $1 ": " $2}'
    echo "Done"
    break
  fi
  sleep 30
done
```
