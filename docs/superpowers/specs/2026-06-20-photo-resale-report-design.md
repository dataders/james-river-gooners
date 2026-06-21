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
2. **Query vector = fused text + vision.** Build the 768-dim query vector the same way
   corpus rows are built: `normalize(normalize(text) + normalize(image))`, text via HF
   `nomic-embed-text-v1.5` (`search_query: <searchQuery>`), image via HF
   `nomic-embed-vision-v1.5`.
3. **Progressive reveal, no SSE.** The client fans out the later stages as independent
   calls (each its own TanStack Query / loading state); the modal fills in three sections.
4. **Spend guard = light per-user daily cap only.** No global budget coupling (overkill
   at 50k/day). A small `resale_scan_log` circuit-breaker (e.g. 50 live fetches/user/day)
   guards against a buggy client / scripted abuse; over cap → smart-link fallback.
5. **Members-only**, auto-run on capture.

## Architecture — three progressive stages

The client orchestrates; each stage renders the moment it lands.

### Stage 1 — Identification (~2–4s) — `image-search` (extended)
Extend the `identify_item` tool schema from the thin subset up to the **full v6
enrichment** the scraper produces, so the report matches the rest of the app:
`searchQuery`, `productType`, `condition` (enum), `conditionFlags`, `keyAttributes`,
`detailCategory` + `details`, `quantity`, `isMixedLot`, `secondaryItems`, and separate
`brandConfidence` / `modelConfidence` / `detailConfidence`. (Re-express the Python
enrichment schema from `scraper/enrich.py` as the TS tool schema; keep enum closure on
`condition`/confidence as today.) Renders immediately.

### Stage 2 — eBay comps, rough-but-fast — `resale-ebay` (new edge fn)
Fires the instant Stage 1 returns, keyed on `searchQuery` text only.
- Check per-user daily cap (`resale_scan_log`). Under cap → call SoldComps
  `/v1/scrape` (minimal port of `ebay_fetch.soldcomps_sold_matches`: brand/model/query
  params, parse matches → price, sold date, condition, thumbnail, **eBay item URL**).
  Log one row.
- Over cap or live error → degrade to **smart-link** (`buildEbaySoldSearches` curated
  "Sold & Completed" URL).
- Returns text-ranked sold rows + the "see all sold on eBay" link. Render real prices,
  each row a clickable listing.

### Stage 3 — Semantic refine (slowest) — `resale-embed` (new edge fn)
Fires **in parallel** with Stage 2, keyed on `{searchQuery, imageBase64}`.
- Build fused text+vision 768-dim query vector (HF text + HF vision + fuse).
- `match_sold_listings_by_vector(vec, k, min_sim)` → corpus eBay comps, similarity-ranked.
- `match_cannons_comps_by_vector(vec, k, min_sim)` → local Cannon's/HiBid/Rasmus sold lots.
- Returns both sets. On arrival the client:
  - **(a)** merges corpus comps into the eBay section, deduping by `ebay_item_id`, and
    **re-sorts** so highest-similarity matches rise to the top; live-only items (no
    embedding) sort after, by relevance.
  - **(b)** reveals the **local history** section (each row → clickable lot detail link;
    show median).
  - **(c)** firms up the headline **estimated value** (prefer eBay sold median + range;
    fall back to local-history median; final fallback to Haiku's `estimatedValue`).

## New/changed pieces

**Edge functions**
- `image-search` — extend tool schema to full v6 enrichment (Stage 1).
- `resale-ebay` *(new)* — live SoldComps on `searchQuery` + per-user cap + smart-link
  fallback (Stage 2).
- `resale-embed` *(new)* — fused text+vision embed → two `*_by_vector` RPCs (Stage 3).

**SQL (additive migrations only)**
- `match_sold_listings_by_vector(query_embedding vector(768), match_count int, min_sim float)`
  — KNN over `sold_listing_embeddings` ⨝ `sold_listings`; returns the same display columns
  as `match_sold_listings`. No auction/item context required.
- `match_cannons_comps_by_vector(query_embedding vector(768), match_count int, min_sim float)`
  — KNN over `nomic_embeddings` ⨝ `sold_lots` (`final_bid > 0`); returns title, sold_price,
  sold_at, image_url, detail_url, auction_title, source, similarity. No own-auction exclusion
  (there is no source lot).
- `resale_scan_log(user_id uuid, created_at timestamptz default now())` (+ index on
  `(user_id, created_at)`) — per-user daily cap ledger. RLS: secret-key/service-role only.

**Frontend**
- `useImageSearch.js` → split/extend into the staged orchestrator (Stage 1 query; on
  success fan out Stage 2 + Stage 3 as parallel TanStack Queries). Keep base64 client-side
  and pass to Stages 1 and 3.
- `ImageSearchModal.jsx` → three sections (Identification · eBay comps · Local history) each
  with its own skeleton → content state, plus the headline estimate.
- Reuse `EbayComps.jsx` / `CannonsComps.jsx` for rows; reuse `ebayComps.js` /
  `cannonsComps.js` link + median helpers so links/formatting match the rest of the app.

## Data flow

```
[photo] ──▶ image-search (Haiku, full enrichment) ──▶ Stage 1: Identification ▼ (render)
                        │ searchQuery
          ┌─────────────┴──────────────┐ (parallel)
          ▼                            ▼
   resale-ebay (live SoldComps)   resale-embed (HF text+vision → fuse)
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
  fallback path, the per-user cap decision, and the fused-vector math (text+image
  normalize+sum+normalize). Stub HF + SoldComps HTTP.
- **SQL RPCs** — seed a tiny corpus + sold_lots, assert `*_by_vector` returns
  similarity-ordered rows above threshold and respects `match_count`.
- **Frontend** — the orchestrator's progressive states (Stage 1 only → +Stage 2 →
  +Stage 3 merged); dedupe-by-`ebay_item_id` + re-sort; estimate fallback chain;
  cap-exhausted → smart-link rendering. Mock `supabase.functions.invoke` per stage.
- **UI screenshots** — mobile (375×667) + desktop (1280×800) of the three-section
  modal in skeleton and filled states (per CLAUDE.md screenshot rule), before merge.

## Risks & validation

- **HF serving the vision model (primary risk).** `embed-query` uses the legacy
  `api-inference.huggingface.co/pipeline/feature-extraction/<model>` text endpoint.
  Must validate that `nomic-ai/nomic-embed-vision-v1.5` is callable for **image**
  feature-extraction and returns a 768-dim vector in the same space. **Validate
  before building Stage 3.** Fallbacks, in order of preference:
  1. A different HF inference route/endpoint that serves the vision model.
  2. A tiny dedicated embedding service (the scraper's Nomic vision already runs in
     Python — expose a minimal authenticated endpoint).
  3. **Ship Stage 3 text-only for v1** (text-query vector against the fused corpus —
     the proven `match_lots` path) and add vision later. Stage 3 still delivers corpus
     comps + local history; only the visual-similarity boost is deferred.
- **Edge fn wall-clock** — live SoldComps adds seconds; the staged/parallel design keeps
  it off the identification path, so it never delays Stage 1.
- **Schema parity drift** — the TS enrichment tool schema duplicates `scraper/enrich.py`.
  Note the source of truth in code so they stay aligned when the Python schema bumps.

## Out of scope (v1)

- Global SoldComps budget coupling (per-user cap only).
- SSE streaming (client fan-out achieves progressive reveal).
- Persisting scan results / writing them back into the corpus or `ebay_comp_snapshots`
  (read-only report for now).
- Facebook Marketplace beyond the existing search link.
```
