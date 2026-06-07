# CLAUDE.md

Better browsing UI for Cannon's Auctions (Richmond VA). Scraper fetches Maxanet data → Parquet files → React SPA on GitHub Pages.

## Architecture

**Scraper** (`scraper/`) — Python scripts: discover auctions, fetch source data, normalize categories, write Parquet to `public/data/`. Three sources, one shared item schema: Maxanet/Cannon's (`scrape.py`), HiBid (`scrape_hibid.py` + `hibid_sources.yml`), and Rasmus (`scrape_rasmus.py` + `rasmus_sources.yml`). `rescrape_all.py` discovers + scrapes all three (`--source maxanet|hibid|rasmus` to limit).

**Rasmus source** (`scrape_rasmus.py`) — Rasmus runs on the auction-engine.com platform backed by a public Firebase Firestore project (`dark-shade`). Lots live in the world-readable top-level `items` collection tagged `origin_sid: rasmus_auctions_appspot_com`; the scraper reads them via the Firestore REST `:runQuery` API (no key secret — it's the browser-side Firebase web key). Rasmus sells nationwide, so discovery is Richmond-first: a cheap projected query (`aid` + `time_end`) finds active auctions, then each auction's prerendered `<title>`/`og:title` is checked against `rasmus_sources.yml` `location_keywords` (the city only exists in the page title — the per-item `location` field is a warehouse bin, not queryable). Only Richmond-area, non-real-estate auctions get their lots fully pulled. `uniqueBidders` comes free from each lot's `bidders_by_uid`; `totalBids` has no truer source than that distinct-bidder count.

**Metadata enrichment** (`scraper/enrich.py`, #99/#104) — after each scrape, asks Claude Haiku (`claude-haiku-4-5`) to read every lot (text + first photo) and extract structured resale metadata: `brand`, `modelOrSku`, `condition`, `productUrl`, `enrichmentConfidence`. Written back onto the item dict so they persist to the NDJSON/Parquet read model alongside everything else (seeded empty on every row so the Parquet schema stays consistent). Structured outputs (json_schema) keep `condition`/`confidence` on closed enums; a non-http `productUrl` or invalid enum is dropped to `""` rather than trusted (no hallucinated links reach the UI). **Opt-in and key-gated**: `enrich_items` is a silent no-op unless `GOONERS_ENRICHMENT=1` AND `ANTHROPIC_API_KEY` is set AND the `anthropic` SDK imports — so the scrape, static site, and CI behave unchanged by default. Per-lot API failures are isolated (logged + skipped); runs are concurrent (`GOONERS_ENRICHMENT_WORKERS`, default 8). The `Scrape Auction Data` workflow carries the key as a secret + an `enrichment` dispatch toggle; scheduled runs leave it off until quality is validated. Two consumers: `ebay_comps.build_ebay_sold_searches` uses `brand`+`modelOrSku` as the primary exact-phrase query when confidence is medium/high (low/absent falls through to the existing description/token query, so junk enrichment never worsens comps); the UI (#104) displays the fields at any confidence. Backfill the existing read model with `python enrich.py <safeId> …`.

**Enrichment in the API** (`scraper/supabase_enrichment.py`) — after enrichment, each scraper mirrors the *identified* lots (medium/high confidence only — the same display bar as the UI, keeping the table a clean product index, not a row per lot) into the Supabase `lot_enrichment` table via `maybe_export_enrichment`, keyed on `(auction_safe_id, item_id)`, same PostgREST upsert mechanics as `sold_history.py`. Transient failures (network/429/5xx) retry with backoff; the inline hook **warns rather than crashing the scrape** (the local read model is the primary deliverable) and warns when Supabase is half-configured (URL set, key missing). True no-op only when Supabase is entirely unconfigured or no lots were enriched, so a scrape without Supabase behaves unchanged. The browser/API reads the RLS-public `public_lot_enrichment` view (publishable key); the `model` column records which LLM produced the row (`enrichmentModel`, stamped by `enrich.py`). Backfill the table from already-enriched NDJSON with `python supabase_enrichment.py [<safeId> …]`. SQL: `supabase/migrations/0009_lot_enrichment.sql`. The grid's **✨ Identified** toggle (`App.jsx`, `hasEnrichment` in `src/utils/enrichment.js`) filters to lots with a display-ready brand/model.

**Frontend** (`src/`) — Vite + React 19 SPA. Reads the per-auction NDJSON sidecars in-browser (one `fetch` per auction via `src/hooks/useAuctionData.js`); no Parquet/Arrow runs client-side. Masonry grid, filtering (auction/category/price/search), keyword + CLIP semantic search, favorites, infinite scroll, dark mode.

**Auth + cloud favorites** (`src/lib/supabase.js`, M2/#91-#93) — Supabase email/password auth. Single browser client in `src/lib/supabase.js` reads `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` (the `sb_publishable_…` key, browser-safe given row-level security); `supabase`/`isSupabaseConfigured` are null/false when those env vars are absent so the static site still works offline. `useAuth` exposes the session; `useFavorites(user)` is offline-first — the `gooners-favorites` cookie is the source of truth when logged out, the RLS-protected `favorites` table when logged in (cookie favorites merge up on first login). `useIgnored(user)` is its exact mirror for the "not interested" list (`gooners-ignored` cookie + `ignored` table); ignored items are hidden from the grid by default and surfaced via the **Ignored** toggle. Favorites and ignores are mutually exclusive — `App.jsx` clears one when the other is set (`removeIgnored`/`removeFavorite`). A `SwipeDeck` (Tinder-style) lets users review undecided items one card at a time: swipe/→ favorites, swipe/← ignores, ↓ skips. SQL lives in `supabase/migrations/`. The `sb_secret_…` key (`SUPABASE_SECRET_KEY`) is backend-only — never in a `VITE_` var or the bundle.

**Telemetry** (`src/lib/telemetry.js`) — anonymous, cookieless PostHog. Single client mirrors the Supabase pattern: reads `VITE_POSTHOG_KEY` (+ optional `VITE_POSTHOG_HOST`, defaults to US cloud); `isAnalyticsConfigured` is false and all helpers no-op when the key is absent, so the static site runs with no analytics. Init once in `main.jsx`. Privacy posture: `person_profiles: 'identified_only'` (anonymous sessions counted but never get a stored profile), `persistence: 'localStorage'` (no tracking cookies), `respect_dnt`, autocapture + session recording OFF — only explicit `captureEvent()` calls (e.g. `favorite_toggled`) plus pageviews. `useAuth` calls `identifyUser(user.id)` on login and `resetAnalytics()` on logout, so auth vs unauth sessions are distinguishable. The key is a write-only ingestion key (browser-safe); the personal `phx_…` admin key must never reach a `VITE_` var or the bundle. The module is named `telemetry.js` (not `analytics.js`) on purpose: content blockers like uBlock Origin block any dev-server request whose path contains `analytics`, which broke the import chain in `main.jsx` and blanked the page (the bundled prod build is unaffected since the path is hashed away). Don't rename it back.

**Changelog / What's New** (`src/data/changelog.js`, `src/utils/whatsNew.js`, `src/components/WhatsNewModal.jsx`, `CHANGELOG.md`) — user-facing release notes. `src/data/changelog.js` is the **single source of truth** (newest entry first; each a dated group of plain-language change lines with a stable `id`, written for someone browsing auctions, not implementation detail); it feeds both the in-app ✨ "What's New" panel and `CHANGELOG.md`, which must stay in sync. Seen-tracking is **per individual change**, keyed on each line's `id` (`src/utils/whatsNew.js` pure helpers; `useWhatsNew` persists the seen set under the `gooners-whatsnew-seen` localStorage key, migrating the old date-string format): the header ✨ button shows an "unseen" dot while any line is unseen, and the panel badges each unseen line **New**. **Keep this current** — whenever you ship something a user would notice (a feature, a visible behavior change), add a dated entry at the top of `changelog.js` (and mirror the lines into `CHANGELOG.md`) with a fresh, **never-reused** `id` per line so returning users see exactly the new lines flagged. Don't log internal-only refactors, data refreshes, or scraper plumbing.

**Data layout** (the browser reads NDJSON; Parquet is written alongside it as the warehouse/manifest source, not served to the SPA):
- Active: `public/data/manifest.json` + `public/data/items/{safeId}.ndjson` (+ `.parquet`, `.embeddings`)
- Archived: `public/data/archive-manifest.json` + `public/data/archive/items/{safeId}.ndjson` (loaded only when archive toggle is on)
- eBay comps (#6): Supabase is the sole source. The browser reads the `public_auction_comps` view (publishable key); when Supabase is unconfigured, comps are simply unavailable. **Members-only:** as of `0008_gate_resale_intelligence_behind_auth.sql` the underlying `ebay_comp_snapshots` SELECT policy requires an authenticated session, so a logged-out browser reads zero rows. `App.jsx` passes `enabled={Boolean(auth.user)}` to `useEbayComps` and shows `ResaleInsightsGate` (a "log in to unlock" CTA) in the item detail panel instead of the comps cluster. The scraper writes comps to `ebay_comp_snapshots` via `scraper/supabase_comps.py` when `GOONERS_WAREHOUSE=supabase` (needs `SUPABASE_URL` + `SUPABASE_SECRET_KEY`) and uses the table as its own ledger — freshness + request budget come from the `comp_item_freshness` / `comp_query_attempts` views (`SupabaseCompLedger`), so no per-run JSON is written. Without Supabase it falls back to the legacy static `public/data/ebay-comps/{safeId}.json` read model + file ledger (`FileCompLedger`).
- Cannon's comps: similar *past* (archived) lots and what they sold for. Precomputed in the scraper by `cannons_comps.py` (CLIP similarity of each active item vs the archive corpus). **Members-only, Supabase-backed (#132 part 3 / #150):** the scraper writes the top-K matches per active item to the `cannons_comp_snapshots` table (`scraper/supabase_cannons_comps.py`, secret key — inserts the run's rows tagged `generated_at`, then prunes that auction's older generations) when `SUPABASE_SECRET_KEY` is set; the browser reads the deduped `public_cannons_comps` view (latest generation per item) via `useCannonsComps`, reshaped by `groupSupabaseCannonsComps` and rendered by `src/components/CannonsComps.jsx`. `0009_cannons_comps.sql` gates the table's SELECT to authenticated sessions (mirrors 0008), so logged-out reads are zero rows — this enforces the gating #149 could only fake at the UI level. The `Refresh Cannon's Comps` Action regenerates it (now writes to Supabase + commits only the `.embeddings` cache). Without `SUPABASE_SECRET_KEY` the scraper falls back to the legacy static `public/data/cannons-comps/{safeId}.json` read model for local dev/offline (the browser no longer fetches it).
- Sold-price history (#94/#95, M3): every closed lot's final hammer price. `scrape.py` carries `closed`/`finalBid` per lot; `rescrape_all.finalize_closed_file` promotes the last-seen `currentBid` to `finalBid` and marks `closed` when an auction is archived (`backfill_closed.py` does the same for backfilled-closed auctions, and `rescrape_all.py --backfill-final-prices` one-shots already-archived lots). `scraper/sold_history.py` upserts those sold lots from the archive NDJSON into the Supabase `sold_lots` table (keyed on `auction_safe_id`+`item_id`, secret key, idempotent; the `Refresh Sold-Price History` Action runs it daily). The browser reads `public_sold_lots` (per-item history) and `public_category_sold_stats` (per-category median/range/recency) with the publishable key. **Members-only:** `0008_gate_resale_intelligence_behind_auth.sql` restricts the `sold_lots` SELECT policy to authenticated sessions, so these views return zero rows when logged out (`useCategorySoldStats(Boolean(auth.user))`); the scraper's secret-key writes bypass RLS and are unaffected. MotherDuck `listing_snapshots` also gains `final_bid`/`closed` columns for the optional snapshot path.

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

# Optional LLM enrichment (brand/model/condition; needs ANTHROPIC_API_KEY)
GOONERS_ENRICHMENT=1 uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml --with anthropic python3 scrape.py "<full_auction_url>"
GOONERS_ENRICHMENT=1 uv run --with pyarrow --with anthropic python3 enrich.py "<safeId>"   # backfill existing read model
```

## Key Constraints

- Never use pip/pip3 — always `uv`
- Auction URLs must include all query params (`AuctionId`, `Title`, etc.) — Maxanet redirects to homepage without them
- Maxanet API needs session cookies + `X-Requested-With: XMLHttpRequest`; `GetAuctionItems` returns HTML fragments (not JSON); `GetCategories` returns JSON
- `rescrape_all.py` auto-discovers auctions; `scraper/auction_urls.txt` is a manual fallback only
- `backfill_closed.py --source {cannons,rasmus,hibid}` backfills already-closed auctions straight into the archive — the historical sold-price corpus for future comps. Auctions already in the active/archive read model are skipped by default (re-scraping clobbers data captured while live). Per source:
  - `cannons` — `GetAuctions` `filter=Past`. Closed lots carry no countdown, so `scrape.py`'s `auction_date_from_title` derives the end date from the title's `MM/DD/YY` prefix. `--limit N`.
  - `rasmus` — Firestore lots whose `time_end` is in the last `--days` (default 90), filtered to Richmond-area (Rasmus is nationwide, so this scan is heavy). `--limit N --days 90`.
  - `hibid` — closed catalog IDs listed under `closed_catalog_ids` in `hibid_sources.yml` (HiBid blocks automated past-auction discovery, so IDs are config-driven). Closed lot pages expose `Price Realized: N USD` as the final price.
- Category normalization: `scraper/categories.py` + `scraper/category_mappings.yml`. Cannon's lots whose site Type is "Other" carry their detail in the description (the title is a `Lot - N` placeholder), so `category_mappings.yml` `description_keywords` are ordered by reliability (furniture nouns → precious metals → china nouns → bare materials; first match wins). `scraper/recategorize.py` re-derives `category`/`rawCategory` across the read model from the current mappings (idempotent, only improves "Other"; rewrites NDJSON + Parquet); re-run `sold_history.py` afterward so the Supabase category stats follow.
- MotherDuck: appends to `listing_snapshots` table in `my_db`; both tokens must stay out of committed files; use `duckdb==1.5.2`
  - `MOTHERDUCK_TOKEN` — read/write PAT; used by scraper and Claude Code MCP server
  - `MOTHERDUCK_READ_TOKEN` — read-scaling token; safe to expose to browsers/CDN; used in GitHub Actions as `MOTHERDUCK_READ_SCALING_TOKEN` secret for eBay comps export
- Cannon's comps: `cannons_comps.py` matches each active item to the most similar archived lots that sold (CLIP cosine, top-K above `--min-sim`; defaults top-3/0.80, tunable via `--top-k`/`--min-sim` or `GOONERS_CANNONS_COMPS_*` env). Lot titles are generic ("Lot - 207"), so the comp label falls back to the description. `--no-embed` uses only cached `.embeddings` sidecars (never loads the model) for fast incremental runs. Run with `--with sentence-transformers --with pillow --with numpy`.
- CLIP embeddings: `GOONERS_EMBEDDINGS=1` triggers `embed.py` after each scrape; writes `{safe_id}.embeddings` binary alongside `.ndjson`; manifest gains `embeddingsPath`; requires `sentence-transformers` + `pillow`; model cached in `~/.cache/huggingface` after first download. **Incremental:** `generate_and_write` reuses the prior sidecar's vectors for item ids it already holds and only embeds new ids — so an hourly run where only *bids* changed re-embeds nothing and never loads the model (this is the bulk of the scrape's wall-clock). Reuse is keyed on item id, so an edit to an existing lot's photo/text keeps its prior vector until re-listed; `reuse=False` forces a full recompute (e.g. after a model change).
- Nomic embeddings (#165): `GOONERS_NOMIC_EMBEDDINGS=1` + `SUPABASE_SECRET_KEY` triggers `embed_nomic.py` (text+vision, 768-dim → Supabase pgvector `nomic_embeddings`, upsert by `(auction_safe_id, item_id)`). **Also incremental** — `maybe_generate_and_upsert` reads the auction's already-embedded item_ids and embeds only the new ones, so the two ~550 MB models load only when there's new work. Requires `sentence-transformers` + `pillow` + **`einops`** (nomic_bert's `trust_remote_code` modeling file imports it; without `einops` the model fails to load and every upsert is silently skipped — the bug that left the table empty until this was added to the workflow `--with` list).
- Served from a custom domain (`public/CNAME` → `gooners.anders.omg.lol`), so vite uses `base: '/'` (root) in all environments
- The browser reads NDJSON, so numeric fields (`lotNumber`, `totalBids`, `currentBid`) arrive as plain JS numbers — no Arrow/BigInt conversion needed. (The old `parquet-wasm` loader was removed in #52.)
- Network reads from the read model go through `src/utils/net.js` (`fetchWithRetry` / `fetchJsonWithRetry` / `fetchTextWithRetry`): retries 5xx + network errors with exponential backoff, returns 4xx as-is so the comps loader can treat 404 as "no comps yet"
- A top-level `ErrorBoundary` (`src/components/ErrorBoundary.jsx`, wired in `main.jsx`) keeps a render error in one item/component from blanking the whole page

## Rolling out data-backed migrations

When a change moves a read model into Supabase (or adds an auth gate that empties it), the table must be **populated before the new frontend goes live**, or signed-in users briefly see empty sections. The pattern: **populate from the dev branch first, then merge.**

1. **Apply the migration** to the live project (Supabase MCP `apply_migration`, or it's already applied per the PR). New tables are additive — applying early doesn't affect the old frontend still on `main`.
2. **Run the data-refresh GitHub Action from the PR branch** with the `gh` CLI: `gh workflow run <name>.yml --repo dataders/james-river-gooners --ref <branch>` (e.g. `cannons-comps.yml`). The branch carries the workflow + scraper changes that write to the new table, so this populates Supabase while `main` is untouched. The Action commits its embedding/cache artifacts back to the **branch**, so `git pull` before pushing more to it. (The GitHub **MCP** token can't dispatch — `403 not accessible by integration` — but the `gh` CLI's PAT can.)
3. **Verify** the table is populated (service-role count > 0) and the gate holds (anon read = 0 rows).
4. **Merge → deploy.** The new frontend reads a table that's already full — no gap.

This is the inverse of the frontend-first order used for a pure *gate* (#149, where the data already existed and only access changed); here the data is new, so it must lead.

## CI / PR Monitoring

**GitHub CLI is available and authenticated** (`gh`, PAT for `dataders`). Use it for GitHub Actions work the MCP can't do — dispatching workflows (`gh workflow run`), watching runs (`gh run list/view/watch`), reading job logs (`gh run view --log`), re-running, cancelling. **Always pass `--repo dataders/james-river-gooners`:** the git remote is a local proxy, so `gh` can't infer the repo and errors with "none of the git remotes … point to a known GitHub host" without it. Prefer the GitHub MCP tools for PR reads/reviews/comments (richer, structured); reach for `gh` for Actions/dispatch and anything the MCP token lacks permission for.

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
