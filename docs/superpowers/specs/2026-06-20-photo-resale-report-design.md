# Photo Resale Report — Design

**Date:** 2026-06-20
**Status:** Approved for planning
**Author:** Anders + Claude (brainstorming session)

## Summary

Extend the existing "take a picture" feature (`ImageSearchModal`) from a one-shot
item *identifier* into a full **resale report** that runs automatically on one tap:
identify the item (full enrichment), pull **real eBay sold comps**, pull **local
Cannon's/HiBid/Rasmus sold history**, and synthesize an estimated resale value —
all with **clickable links** to the underlying listings/lots. Results stream in
**progressively** (fastest → slowest) so the user never stares at one long spinner.

It is **members-only** (sign-in required), consistent with today's image search and
the RLS gates on all comp data.

## Today (baseline)

- `src/components/ImageSearchModal.jsx` — camera (`<input capture="environment">`) +
  upload modal; shows identification + a couple of related current lots.
- `src/hooks/useImageSearch.js` — sends base64 photo to the `image-search` edge fn,
  builds eBay/Facebook *search URLs* from the result.
- `supabase/functions/image-search/index.ts` — Claude Haiku (`claude-haiku-4-5`)
  vision, `identify_item` tool → `{brand, model, category, keywords, description,
  searchTerms, estimatedValue}`. JWT-gated (members only).

**Gaps to close:** (1) identification is a thin subset of the scraper's enrichment;
(2) no real eBay sold prices — only a search link; (3) no local Cannon's/HiBid/Rasmus
history for an arbitrary photo.

## Existing infrastructure we build on

- **Sold-listings corpus** — `sold_listings` + `sold_listing_embeddings`
  (768-dim Nomic, fused text+vision, HNSW). The deduped set of every eBay sold listing
  the scraper has pulled. This is "the eBay comps already in my Supabase."
- **Local sold history** — `nomic_embeddings` (lot vectors, same 768-dim space) ⨝
  `sold_lots` (final hammer prices). `match_cannons_comps` already does this for
  *existing* auction lots.
- **Text query embedding in an edge function** — `embed-query` already calls the HF
  Inference API (`nomic-ai/nomic-embed-text-v1.5`, `search_query:` prefix, L2-normalized)
  and `match_lots`. Proven path for text-query → fused-corpus matching.
- **Paid eBay fetch** — scraper's `ebay_fetch.py` → SoldComps `https://api.sold-comps.com/v1/scrape`
  (`Authorization: Bearer SOLDCOMPS_API_KEY`), quota reported on `X-Usage-*` headers.
- **Display components** — `EbayComps.jsx`, `CannonsComps.jsx`, and link/query builders
  in `src/utils/ebayComps.js` / `src/utils/cannonsComps.js`.

## Key decisions (from brainstorming)

1. **eBay fidelity = hybrid, speed-first.** Live SoldComps fetch is **in scope**.
   Because the embedding is the long pole but the live eBay search only needs the
   identified `searchQuery` *text*, we fire the **live eBay call as soon as Haiku
   returns** (fast), and let the **embedding refine** the set afterward. Corpus is
   therefore a *refiner*, **not** a cost-saving gate. (Acceptable: 50k SoldComps
   hits/day available — budget is a non-issue.)
2. **Query vector — text first, vision as increment 2.** v1 builds a **text-only**
   query vector (`search_query: <searchQuery>` via HF `nomic-embed-text-v1.5`) — the
   *proven* `embed-query`/`match_lots` path, which already matches a text query against
   the fused text+vision corpus. This removes the single biggest unknown (HF serving the
   vision model) from the critical path while still delivering both new data sources
   (corpus eBay comps + local history). **Increment 2** adds the vision leg and the
   fused recipe `normalize(normalize(text) + normalize(image))` once HF vision serving is
   proven (see Risks). The fuse, when added, must be **byte-identical** to the corpus
   build recipe in `embed_nomic.py` or the cosine space mismatches (acceptance test).
3. **Progressive reveal, no SSE.** The client fans out the later stages as independent
   calls (each its own TanStack Query / loading state); the modal fills in three sections.
4. **Spend guard = light per-user daily cap only.** No global budget coupling (overkill
   at 50k/day). A small `resale_scan_log` circuit-breaker (e.g. 50 live fetches/user/day)
   guards against a buggy *client* / single-account abuse; over cap → smart-link fallback.
   (Residual: open sign-up means N free accounts × 50/day — acceptable given the 50k/day
   budget; not a true abuse wall.) The cap check is an **atomic** insert-guarded count
   (insert-then-count, or an RPC) to avoid a read-then-write race on concurrent taps; the
   table gets a retention/cleanup policy (it grows unboundedly otherwise).
5. **Members-only**, auto-run on capture. **The new resale RPCs return members-only sold
   prices, so they are `SECURITY DEFINER` granted to `authenticated, service_role` ONLY —
   never `anon`** (copying `match_lots`' anon grant would silently defeat the 0008/0030
   gate). The `resale-embed` / `resale-ebay` functions JWT-gate like `image-search`
   (`SUPABASE_SERVICE_ROLE_KEY` + `auth.getUser(token)`), **not** like `embed-query`
   (which uses the anon key and does not auth-gate — wrong template for gated data).

## Architecture — three progressive stages

The client orchestrates; each stage renders the moment it lands.

### Stage 1 — Identification (~2–4s) — `image-search` (extended)
Extend the `identify_item` tool schema to the **subset the report actually renders/keys
on**, not the full 15-field v6 enrichment (avoid duplicating the whole Python schema into
TS for marginal value): `searchQuery` (keys Stages 2 & 3), `brand`, `model` (`modelOrSku`),
`productType`, `condition` (enum), and `brandConfidence`/`modelConfidence` for the display
bar. Keep enum closure on `condition`/confidence as today. A small **field-set parity
test** asserts the TS tool schema's fields are a subset of `scraper/enrich.py`'s
`ENRICHMENT_SCHEMA_VERSION` schema and flags drift when the Python schema bumps (on-brand
with the repo's TS ratchets). Renders immediately. *(Heavier v6 fields —
`secondaryItems`, `isMixedLot`, `detailCategory`/`details`, `conditionFlags`/
`keyAttributes` — are out of v1 scope; add later if the report grows to use them.)*

### Stage 2 — eBay comps, rough-but-fast — `resale-ebay` (new edge fn)
JWT-gated (service-role + `auth.getUser`). Fires the instant Stage 1 returns, keyed on
`searchQuery` text.
- **Atomic** per-user daily cap (`resale_scan_log`: insert-then-count, or guard RPC).
  Under cap → call SoldComps `/v1/scrape` (`Authorization: Bearer SOLDCOMPS_API_KEY`,
  `SOLDCOMPS_API_URL` env-overridable). **v1 sends a keyword query** built from
  `searchQuery` (+ a category id *if* cheaply derivable — confirm the exact helper, e.g.
  `ebay_category_id`/`EBAY_CATEGORY_IDS` in `ebay_query.py`, is portable to TS; otherwise
  drop the category id, it's optional for v1); it does **not** port the full
  `build_ebay_sold_searches` /
  `soldcomps_sold_matches` funnel (specific→broad→category tiers, condition/price filters,
  leaf-category lookup) — that precision is explicitly deferred. Parse matches → price,
  sold date, condition, thumbnail, **eBay item URL**. Log one row.
- Over cap or live error → degrade to **smart-link** (`buildEbaySoldSearches` curated
  "Sold & Completed" URL).
- **Response contract:** `{ status: 'ok' | 'over_cap' | 'live_error' | 'no_results',
  rows, searchUrl }` so the UI shows the right message ("you've hit today's scan limit"
  vs "eBay unavailable" vs "no sold comps found"). Render real prices, each row a
  clickable listing.

### Stage 3 — Semantic refine (slowest) — `resale-embed` (new edge fn)
JWT-gated. Fires **in parallel** with Stage 2, keyed on `{searchQuery, imageBase64}`.
- **v1: text-only** 768-dim query vector (`search_query: <searchQuery>` via HF
  `nomic-embed-text-v1.5`, L2-normalized — exactly `embed-query`'s `embedQuery`).
  **Increment 2** adds the HF vision leg + fuse (see Risks); the fuse needs *both* HF
  legs, so if vision is added and times out, **degrade at runtime to the text-only
  vector** rather than failing the stage.
- `match_sold_listings_by_vector(vec, k, min_sim)` → corpus eBay comps, similarity-ranked.
- `match_cannons_comps_by_vector(vec, k, min_sim)` → local Cannon's/HiBid/Rasmus sold lots
  (corpus is **archive-only**: `sold_lots` is filtered to archived `final_bid > 0`, so a
  currently-live lot can't surface as its own comp — no own-auction guard needed).
- **Thresholds:** start `k≈8` (eBay) / `k≈5` (local), `min_sim≈0.75` — *looser* than the
  lot-tuned 0.78/0.80 because a phone photo's `searchQuery` embeds less cleanly than a
  scraped lot; tune against real scans.
- Both RPCs are called with the user's bearer token (or service-role after JWT verify) so
  the `authenticated` grant + the views' `auth.uid()` predicate pass.
- Returns both sets. On arrival the client:
  - **(a)** merges corpus comps into the eBay section, deduping by `ebay_item_id`.
    **Re-sort comparator:** corpus rows with `similarity ≥ min_sim` first, sorted by
    similarity desc; then the live-only Stage-2 rows (which have no embedding/score)
    appended in their original eBay order. (No sentinel score is invented for live rows.)
  - **(b)** reveals the **local history** section (each row → clickable lot detail link;
    show median).
  - **(c)** firms up the headline **estimated value**, computed over the **merged, deduped
    eBay set** (median + range via the existing `ebayComps.js` helpers), recomputed after
    the Stage-3 merge; fall back to local-history median, then Haiku's `estimatedValue`.

## New/changed pieces

**Edge functions** (all JWT-gated like `image-search`)
- `image-search` — extend tool schema to the report's enrichment subset (Stage 1).
- `resale-ebay` *(new)* — live SoldComps keyword search on `searchQuery` + atomic per-user
  cap + smart-link fallback + discriminated `status` (Stage 2).
- `resale-embed` *(new)* — **v1 text-only** embed → two `*_by_vector` RPCs (Stage 3);
  vision leg added in increment 2.

**SQL (additive migrations only)**
- `match_sold_listings_by_vector(query_embedding vector(768), match_count int, min_sim float)`
  — KNN over `sold_listing_embeddings` ⨝ `sold_listings`; returns the same display columns
  as `match_sold_listings`. No auction/item context required. **`SECURITY DEFINER`, granted
  to `authenticated, service_role` only — NOT `anon`** (returns members-only sold prices).
- `match_cannons_comps_by_vector(query_embedding vector(768), match_count int, min_sim float)`
  — KNN over `nomic_embeddings` ⨝ `sold_lots` (`final_bid > 0`); returns title, sold_price,
  sold_at, image_url, detail_url, auction_title, source, similarity. No own-auction exclusion
  (there is no source lot). **`SECURITY DEFINER`, granted to `authenticated, service_role`
  only — NOT `anon`.**
- `resale_scan_log(user_id uuid, created_at timestamptz default now())` (+ index on
  `(user_id, created_at)`) — per-user daily cap ledger, written by the service-role edge fn.
  RLS on, no policies (service-role bypasses). Cap check is atomic (insert-then-count or a
  guard RPC). Add a retention job/policy (e.g. prune rows older than the cap window) so it
  doesn't grow unbounded.

**Frontend**
- `useImageSearch.js` → split/extend into the staged orchestrator (Stage 1 query; on
  success fan out Stage 2 + Stage 3 as parallel TanStack Queries). **Downscale the photo
  client-side before upload**; keep the base64 client-side and pass to Stages 1 and (in
  increment 2) 3.
- `ImageSearchModal.jsx` → three sections (Identification · eBay comps · Local history) each
  with its own skeleton → content state, plus the headline estimate.
- Reuse `EbayComps.jsx` / `CannonsComps.jsx` for rows; reuse `ebayComps.js` /
  `cannonsComps.js` link + median helpers so links/formatting match the rest of the app.

## Data flow

```
[photo] ──▶ image-search (Haiku, enrichment subset) ──▶ Stage 1: Identification ▼ (render)
                        │ searchQuery
          ┌─────────────┴──────────────┐ (parallel)
          ▼                            ▼
   resale-ebay (live SoldComps)   resale-embed (HF text embed; +vision in incr. 2)
          │                            ├─ match_sold_listings_by_vector  (corpus eBay)
          ▼                            └─ match_cannons_comps_by_vector   (local history)
   Stage 2: eBay rows ▼ (render)         │
                                         ▼
                              Stage 3: merge/re-sort eBay (dedupe ebay_item_id),
                                       reveal local history, firm up estimate ▼ (render)
```

## Error handling & degradation

- **Not signed in / Supabase unconfigured** — feature unavailable (existing gate).
- **Stage 1 fails** — surface error in modal; no later stages fire.
- **Stage 2 over cap / live error** — smart-link fallback (curated eBay sold URL);
  section still useful.
- **Stage 3 fails (HF or RPC)** — eBay section stays as Stage 2 left it (text-ranked,
  no re-sort); local-history section shows an empty/"none found" state; estimate falls
  back to eBay median or Haiku estimate. Stage 3 failure never blocks Stages 1–2.
- Each edge fn returns `{ ...payload, error? }` and never throws across the boundary
  (matches `embed-query`); the client treats partial results as first-class.

## Testing

- **Edge functions** — unit-test the SoldComps response → row mapping, the smart-link
  fallback path, the discriminated `status` (ok/over_cap/live_error/no_results), the atomic
  per-user cap decision, JWT-gating (401 without a valid token), and the text-embed
  normalization. (Increment 2: the fused-vector math text+image normalize+sum+normalize,
  byte-identical to `embed_nomic`.) Stub HF + SoldComps HTTP.
- **SQL RPCs** — seed a tiny corpus + sold_lots, assert `*_by_vector` returns
  similarity-ordered rows above threshold and respects `match_count`.
- **Frontend** — the orchestrator's progressive states (Stage 1 only → +Stage 2 →
  +Stage 3 merged); dedupe-by-`ebay_item_id` + re-sort; estimate fallback chain;
  cap-exhausted → smart-link rendering. Mock `supabase.functions.invoke` per stage.
- **UI screenshots** — mobile (375×667) + desktop (1280×800) of the three-section
  modal in skeleton and filled states (per CLAUDE.md screenshot rule), before merge.

## Risks & validation

- **HF serving the vision model (deferred to increment 2, not on the v1 path).** v1 Stage 3
  is text-only (the proven `embed-query`/`match_lots` path), so this risk no longer blocks
  shipping. Before building increment 2's vision leg, validate that
  `nomic-ai/nomic-embed-vision-v1.5` is callable for **image** feature-extraction over HF
  Inference and returns a same-space 768-dim vector — `embed-query` only ever uses the
  legacy *text* `pipeline/feature-extraction` route, and the scraper runs Nomic vision via
  local `transformers AutoModel/AutoImageProcessor`, never via HF Inference, so this is
  genuinely unproven. Fallbacks if HF won't serve it: (1) another HF route; (2) a tiny
  dedicated embedding service wrapping the scraper's Nomic vision; (3) stay text-only.
  When vision is added, the fused query vector must be **byte-identical** to
  `embed_nomic`'s document recipe (`normalize(normalize(text)+normalize(image))`) or the
  cosine space mismatches — pin this with an acceptance test.
- **Edge fn wall-clock / timeouts.** v1's `resale-embed` is one HF text call + two
  single-vector KNN RPCs (fast). Set a per-HF-call timeout; on HF failure the stage returns
  `{error}` and the eBay section simply stays as Stage 2 left it. The staged/parallel design
  keeps SoldComps + embedding off the identification path, so neither delays Stage 1.
  (Increment 2's second HF call is the real latency risk — hence the runtime text-only
  degrade.)
- **Photo payload size.** A multi-MB phone photo flows to `image-search` and (increment 2)
  `resale-embed`. Require **client-side downscale** before upload (the scraper downscales
  before embedding; the edge path has no equivalent today) to bound payload, cost, and
  latency.
- **Schema parity drift** — the Stage-1 TS tool schema is a *subset* of
  `scraper/enrich.py`; a field-set parity test (see Stage 1) flags drift when the Python
  `ENRICHMENT_SCHEMA_VERSION` schema bumps.

## Out of scope (v1)

- **Vision embedding leg** — increment 2, once HF vision serving is proven (Stage 3 is
  text-only in v1).
- Full `build_ebay_sold_searches` funnel in the edge fn (v1 sends a keyword query;
  tiered/condition/price precision deferred).
- Heavier v6 enrichment fields (`secondaryItems`, `isMixedLot`, `detailCategory`/`details`,
  `conditionFlags`/`keyAttributes`).
- Global SoldComps budget coupling (per-user cap only).
- SSE streaming (client fan-out achieves progressive reveal).
- Persisting scan results / writing them back into the corpus or `ebay_comp_snapshots`
  (read-only report for now).
- Facebook Marketplace beyond the existing search link.
```
