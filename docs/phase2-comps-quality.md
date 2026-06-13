# Phase 2 — sold-comps quality: corpus, visual re-rank, reuse, leaf categories

**Status:** design / RFC (no code yet — approve before build)
**Builds on:** Phase 1 (#283) — structured `/v1/scrape` filters (US-only, recency,
`minPrice`, wide `count`, L1 `categoryId` + condition on the precise tier).

Phase 1 made each comp *query* sharper. Phase 2 makes the comp *results* sharper
and the spend lower, by turning the listings we already pay for into a reusable,
visually-searchable corpus. Four increments, built in dependency order as
separate PRs:

| # | Increment | Depends on | Needs from you |
|---|-----------|-----------|----------------|
| 1 | Raw sold-listings **corpus** | — | nothing |
| 2 | Batch **Nomic visual re-rank** | 1 | nothing |
| 3 | **Corpus-first reuse** (skip the API) | 1, 2 | nothing |
| 4 | eBay **category tree** → leaf scoping | — (parallel) | eBay dev OAuth token |

The guiding idea: today `soldcomps_sold_matches` fetches up to `count` (40)
listings per query and **throws away all but the top `max_matches` (3)**. That
discarded data is the asset. Increment 1 keeps it; 2 makes it visually
searchable; 3 reuses it to avoid re-paying; 4 sharpens the query that fills it.

---

## Increment 1 — Raw sold-listings corpus

### Goal
Persist the **full** candidate set per `/v1/scrape` call (all ~`count` listings,
not just the 3 kept for the curated comps) into a new `sold_listings` Supabase
table, deduped by eBay listing id. This is pure capture of data we already fetch
— lowest-risk, no new external calls — and the sooner it lands the sooner the
corpus accumulates for increments 2–3.

### Capture point
`scraper/ebay_fetch.py::soldcomps_sold_matches` already parses every raw provider
item via `soldcomps_item_match`, then truncates to `max_matches`. Change: build
the **full** deduped candidate list and return it on the result dict
(`result["all_candidates"]`) alongside the existing `matches`. The fetch loop in
`ebay_comps.py::fetch_direct` then hands `all_candidates` to a new, gated,
warn-not-crash mirror — exactly the posture of the enrichment / comps / Nomic
hooks (the local read model stays primary; a corpus write never aborts a scrape).

Only the SoldComps API path yields the rich structured candidate set; the
HTML-scrape fallback (`parse_sold_search_html`) stays at its 3-card cap (it's a
last resort, not the corpus source).

### Schema — `supabase/migrations/0023_sold_listings.sql`
```sql
create table sold_listings (
  ebay_item_id   text primary key,        -- dedup key: one row per sold listing
  title          text,
  sold_price     numeric,
  sold_currency  text,
  sold_date      date,
  sold_date_label text,
  category_id    text,                     -- the eBay categoryId we queried under
  condition      text,
  thumbnail_url  text,
  item_web_url   text,
  source_query   text,                     -- last query that surfaced it (debug)
  seen_count     int  not null default 1,  -- # distinct lot-queries that hit it
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  raw_json       jsonb                     -- full provider item, future-proofing
);
create index on sold_listings (category_id);
create index on sold_listings (sold_date);
alter table sold_listings enable row level security;
-- No anon/authenticated SELECT policy: the corpus is scraper-internal in this
-- increment (nothing in the browser reads it). Only the secret key, which
-- bypasses RLS, reads/writes it. (A public view can be added later if the UI
-- ever surfaces "N comparable sold listings".)
```

A sold listing is **immutable** (its price/date never change once sold), so the
upsert is "insert, or on conflict bump `last_seen_at` + `seen_count`" — first
values win. `Prefer: resolution=merge-duplicates` + an `ON CONFLICT` is the
PostgREST idiom already used by `embed_nomic.upsert_embeddings`.

### Write module — `scraper/supabase_sold_listings.py`
A near-clone of `supabase_comps.py`'s write path: PostgREST `POST`, secret key,
`_SUPABASE_UA` (the secret key is rejected from a browser-looking UA), the
`_request_with_retry` backoff, bounded batches. Entry point
`maybe_mirror_listings(candidates, …)` — true no-op unless `SUPABASE_SECRET_KEY`
is set **and** `GOONERS_SOLD_LISTINGS_CORPUS=1` (opt-in until validated, like
enrichment started). `seen_count` increment on conflict is done with a small RPC
or a `merge-duplicates` upsert that reads-then-writes; simplest first cut: upsert
the row and `seen_count` stays a coarse "last writer" value (exact counting is a
nice-to-have, not load-bearing).

### Retention
A daily `pg_cron` prune (mirror `0004_ebay_comps_retention.sql`): delete rows
whose `sold_date` is older than `GOONERS_CORPUS_RETENTION_DAYS` (default 180) —
a sold listing that old is a weak comp anyway, and this bounds table growth.

### Cost / size
~5k API calls/mo × ~40 candidates ≈ 200k candidate-encounters/mo, deduped to far
fewer unique listings (popular items recur across lot queries), pruned at 180d.
Comfortably inside the free-tier 500 MB (text + a URL per row; `raw_json` is the
only heavy column — drop it if size becomes a concern).

### Tests
Pure-function tests for the full-candidate extraction (all items, deduped, capped
at `count`) and `row_payload` projection; a mocked-session test that
`maybe_mirror_listings` POSTs the expected rows and is a no-op when unconfigured.

---

## Increment 2 — Batch Nomic visual re-rank

### Goal
Re-rank each lot's candidate comps by **visual** similarity (thumbnail) against
the lot's own image, catching the failure text can't: right keywords, wrong
object. Reuses the existing #165 Nomic vision stack.

### Embeddings — `sold_listing_embeddings` (`0024_sold_listing_embeddings.sql`)
Mirror `nomic_embeddings` (migration 0010): `ebay_item_id text primary key,
embedding vector(768), model text, n_images int`, HNSW index. Embed each corpus
row the **same way lots are embedded** — `text("search_document: " + title) +
mean(vision(thumbnail))`, re-normalised (`embed_nomic.embed_items`) — so a corpus
vector lives in the same 768-dim space as `nomic_embeddings` and cosine compares
apples-to-apples.

### Batch job — `scraper/embed_sold_listings.py` + `embed-sold-listings.yml`
A clone of `embed_nomic`'s incremental pattern: read `ebay_item_id`s already in
`sold_listing_embeddings`, embed only the new corpus rows, upsert. Runs as its
**own scheduled Action** (the two ~550 MB models load off the hourly hot path),
reusing the HuggingFace model cache. Device auto-select (CUDA→MPS→CPU) is already
in `embed_nomic._get_device`.

### Re-rank RPC — `match_sold_listings` (`0025_match_sold_listings.sql`)
A direct analogue of `match_cannons_comps` (0014/0015): `security definer`,
`set statement_timeout to '180s'`, per active-lot KNN via `cross join lateral`
and the pgvector cosine operator `<=>`:
```sql
create or replace function match_sold_listings(
  active_auction text, match_count int default 5, min_sim float default 0.78)
returns table (item_id text, ebay_item_id text, similarity float,
               title text, sold_price numeric, sold_date date,
               thumbnail_url text, item_web_url text)
language sql stable security definer set search_path = public
set statement_timeout to '180s' as $$
  select a.item_id, c.ebay_item_id, c.sim, c.title, c.sold_price,
         c.sold_date, c.thumbnail_url, c.item_web_url
  from nomic_embeddings a
  cross join lateral (
    select sl.ebay_item_id, sl.title, sl.sold_price, sl.sold_date,
           sl.thumbnail_url, sl.item_web_url,
           1 - (e.embedding <=> a.embedding) as sim
    from sold_listing_embeddings e
    join sold_listings sl on sl.ebay_item_id = e.ebay_item_id
    order by e.embedding <=> a.embedding
    limit greatest(1, least(match_count, 20))
  ) c
  where a.auction_safe_id = active_auction and c.sim >= min_sim
  order by a.item_id, c.sim desc;
$$;
```

### How the re-rank reaches the UI — **open decision (D2)**
The re-ranked top-K need to become the comps the item-detail panel shows. Two
options:
- **(a) Overwrite the curated table** — a post-fetch step (like `cannons_comps.py`)
  calls `match_sold_listings` and writes the visually-best K into
  `ebay_comp_snapshots` with a distinct `source_query` tag, so the existing
  `public_auction_comps` view and the UI are unchanged. *Recommended* — smallest
  blast radius, UI untouched.
- **(b) New view + UI work** — surface "visual match %" as a new comps source,
  requiring a `public_*` view and `CannonsComps`-style component + a screenshot
  pass. More product surface, more work.

Recommend (a) for the first cut; (b) is a follow-up if we want to *show* the
visual-match score.

---

## Increment 3 — Corpus-first reuse (skip the API)

### Goal
Before spending a `/v1/scrape` request on a lot, check whether the corpus already
covers it well; if so, build the comps from the corpus and **skip the paid call**
— amortising spend once a category is dense.

### Mechanism
In `fetch_direct`, before the per-item query loop, a `corpus_coverage(item)`
check calls `match_sold_listings` (or a category+recency filtered count) for the
lot's embedding. If **≥ `MIN_FRESH` (default 3)** listings exist above `min_sim`
with `sold_date` within **`MAX_AGE_DAYS` (default 90)**, use those as the comps
and skip the API. Otherwise fall through to the API path (which then *feeds* the
corpus for next time).

### Freshness policy — **open decision (D3)**
The reuse thresholds trade spend against staleness:
- Too loose → stale medians (an 8-month-old comp anchors a live lot).
- Too tight → never reuse, no savings.
Defaults `MIN_FRESH=3`, `MAX_AGE_DAYS=90`, `min_sim≈0.80`, all env-tunable.
Honest caveat: this **amortises** — early on you still pay to *build* the corpus;
savings arrive once categories are dense.

### Dependency
Needs 1 (corpus) + 2 (embeddings + RPC), and the lot itself must be embedded in
`nomic_embeddings` (already true for scraped lots when Nomic is on).

---

## Increment 4 — eBay category tree → leaf-level scoping

### Goal
Replace Phase 1's coarse ~25-entry L1 map with **leaf-level** `categoryId`s
(e.g. *Pottery & Glass › Pottery & China › Roseville* instead of just *Pottery &
Glass*), for much tighter category scoping. Independent of 1–3.

### Prerequisite (needs you)
eBay's category tree comes from the **eBay Taxonomy API** (`getCategoryTree`,
marketplace `EBAY_US`, tree id `0`) — **not** by scraping the sold-comps SPA
viewer (a bot-blocked JS app). That API needs a **free eBay developer account +
an OAuth application token** (client-credentials grant). What I'd need from you:
`EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET` as GitHub secrets (I'll mint the app
token from them at runtime). Until then, increments 1–3 proceed without it.

### Schema — `ebay_categories` (`0026_ebay_categories.sql`)
`category_id text pk, name text, full_path text, parent_id text, level int,
leaf boolean`. Loaded once (and refreshed occasionally) by a new
`scraper/ebay_taxonomy.py` + a manual/scheduled Action — one API call returns the
whole tree (~16,986 leaves), flattened and upserted.

### Mapping a lot to a leaf — **open decision (D4)**
- **(a) Name/path match** — match our `category` + enrichment `productType`
  against category `full_path`s. Deterministic, cheap, no embeddings. Start here.
- **(b) Embedding match** — embed category `full_path`s and KNN the lot's
  `nomic_embeddings` against them (a `match_ebay_categories` RPC). Sharpest, but
  adds a category-embedding step. Layer on later if (a) proves too coarse.

`ebay_query.ebay_category_id` keeps the L1 YAML as the **fallback** when no
confident leaf is found, so this only ever improves precision.

---

## Sequencing & rollout

Build order **1 → 2 → 3**, with **4 in parallel** once the eBay token lands. Each
is its own PR. Per the repo's "rolling out data-backed migrations" rule: new
tables are additive and scraper-written, and nothing in the browser reads them in
increments 1–3, so there's **no frontend-gap risk** — apply the migration, let
the scraper populate, and the data accrues before any reader exists. (Increment
2(b)/the UI surface, if we do it, follows the populate-then-merge order.)

## Open decisions to confirm before building
- **D1 — Corpus gating:** opt-in `GOONERS_SOLD_LISTINGS_CORPUS=1` first (validate
  size/quality), or on-by-default whenever Supabase is configured? *Rec: opt-in
  first.*
- **D2 — Re-rank → UI:** overwrite `ebay_comp_snapshots` (UI unchanged) vs a new
  "visual match" comps source. *Rec: overwrite first.*
- **D3 — Reuse thresholds:** `MIN_FRESH` / `MAX_AGE_DAYS` / `min_sim` defaults.
  *Rec: 3 / 90 / 0.80, env-tunable.*
- **D4 — Leaf mapping:** name/path match vs embedding match to start. *Rec:
  name/path first.*
- **D5 — Retention:** corpus prune window. *Rec: 180 days.*

## Testing
Each increment ships with: pure-function unit tests (candidate extraction, row
projection, coverage thresholds, leaf resolution) following the existing
`test_ebay_comps.py` style; mocked-session tests for the Supabase writers
(asserting payloads + no-op-when-unconfigured); and SQL applied via the Supabase
MCP `apply_migration` with a service-role count check before any reader exists.
