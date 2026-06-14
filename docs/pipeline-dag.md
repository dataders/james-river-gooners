# Pipeline DAG

Data flow after the Supabase migration. NDJSON/Parquet files are written locally during a scrape run but **not committed to git** — Supabase is the sole durable destination.

```mermaid
flowchart TD

  %% ── Workflow triggers ──────────────────────────────────────────────────
  wf_scrape["⏰ **scrape.yml**\nhourly"]:::wf
  wf_backfill["▶ **enrich / comps / nomic**\non-demand backfill"]:::wf
  wf_deploy["🚀 **deploy.yml**\non push to main"]:::wf

  %% ── Scraper scripts ────────────────────────────────────────────────────
  sc_cannons["scrape.py\nCannon's / Maxanet"]:::script
  sc_hibid["scrape_hibid.py\nHiBid"]:::script
  sc_rasmus["scrape_rasmus.py\nRasmus / Firebase"]:::script

  %% ── Enrichment + comps ─────────────────────────────────────────────────
  enrich_py["enrich.py\nClaude Haiku"]:::enrich
  ebay_py["ebay_comps.py\nSoldComps API"]:::enrich
  cannons_py["cannons_comps.py\nNomic pgvector RPC"]:::enrich
  nomic_py["embed_nomic.py\n768-dim pgvector"]:::enrich

  %% ── Supabase tables ────────────────────────────────────────────────────
  lots_a[("lots\narchived=false\nactive listings")]:::tbl
  lots_b[("lots\narchived=true\n+ final_bid + sold_at + closed")]:::tbl
  enr_tbl[("lot_enrichment\nbrand / model / sku")]:::tbl
  ebay_tbl[("ebay_comp_snapshots\neBay sold prices")]:::tbl
  can_tbl[("cannons_comp_snapshots\npast Cannon's lots")]:::tbl
  nom_tbl[("nomic_embeddings\npgvector 768-dim")]:::tbl

  %% ── PostgREST views (publishable key + RLS) ────────────────────────────
  views["PostgREST views — publishable key + RLS\npublic_active_lots(_card) · public_archived_lots(_card)\npublic_sold_lots · public_category_sold_stats (views over lots)\npublic_auction_comps · public_cannons_comps · public_lot_enrichment"]:::view

  %% ── Frontend ───────────────────────────────────────────────────────────
  spa["SPA · GitHub Pages\nVite + React 19\nreads PostgREST (auth-gated for resale intel)\nsemantic search via nomic_embeddings"]:::spa

  %% ── Triggers → scripts ─────────────────────────────────────────────────
  wf_scrape --> sc_cannons
  wf_scrape --> sc_hibid
  wf_scrape --> sc_rasmus
  wf_scrape -- "inline (opt-in)" --> enrich_py
  wf_scrape -- "inline step" --> ebay_py
  wf_scrape -- "inline (opt-in)" --> nomic_py

  wf_backfill --> enrich_py
  wf_backfill --> ebay_py
  wf_backfill --> cannons_py
  wf_backfill --> nomic_py

  wf_deploy --> spa

  %% ── Scripts → tables ───────────────────────────────────────────────────
  sc_cannons --> lots_a
  sc_hibid   --> lots_a
  sc_rasmus  --> lots_a

  lots_a -- "archive_lots()\n(rescrape_all --archive-only,\nstamps final_bid + sold_at + closed)" --> lots_b

  lots_a --> enrich_py
  enrich_py --> enr_tbl

  lots_a --> ebay_py
  ebay_py --> ebay_tbl

  lots_b -- "archive corpus" --> cannons_py
  lots_a -- "active items" --> cannons_py
  cannons_py --> can_tbl

  lots_a --> nomic_py
  nomic_py --> nom_tbl

  %% ── Tables → views → SPA ───────────────────────────────────────────────
  lots_a  --> views
  lots_b  --> views
  enr_tbl --> views
  ebay_tbl --> views
  can_tbl --> views
  nom_tbl --> views

  views --> spa

  %% ── Styles ──────────────────────────────────────────────────────────────
  classDef wf     fill:#3b82f6,color:#fff,stroke:#1d4ed8
  classDef script fill:#22c55e,color:#fff,stroke:#15803d
  classDef enrich fill:#86efac,color:#166534,stroke:#15803d
  classDef tbl    fill:#8b5cf6,color:#fff,stroke:#6d28d9
  classDef view   fill:#d1d5db,color:#111827,stroke:#6b7280
  classDef spa    fill:#fbbf24,color:#111827,stroke:#d97706
```

> **Note (June 2026, migration 0030):** `sold_lots` is no longer a separate table — it is now a **view** over `lots WHERE archived AND final_bid > 0`, with the hammer price's close time (`sold_at`) promoted to a real column on `lots`. The old nightly `sold-history.yml` job (and `scraper/sold_history.py`) were removed; `archive_lots()` is the sole writer of archived/sold facts. The satellite tables (`lot_enrichment`, `nomic_embeddings`, `ebay_comp_snapshots`, `cannons_comp_snapshots`, `eval_embeddings`) now carry `ON DELETE CASCADE` foreign keys to `lots`, so pruning a lot cascades its derived rows.

## Key changes from the old architecture

| Before | After |
|--------|-------|
| `scrape.py` → NDJSON/Parquet in `public/data/` → committed to git hourly | `scrape.py` → Supabase `lots` directly (PostgREST upsert) |
| Browser `fetch()`s NDJSON files from GitHub Pages | Browser reads `public_active_lots` / `public_archived_lots` PostgREST views |
| A nightly `sold_history.py` job mirrored closed lots into a separate `sold_lots` table | `sold_lots` is a view over `lots` (archived + `final_bid` + `sold_at`); no separate job |
| `scrape.yml` commits `git add public/data/` every hour | `scrape.yml` has `contents: read` — no git writes |
| NDJSON/Parquet in git history (bloating the repo) | Only code + config in git; all data in Supabase |

## Secrets map

| Secret | Used by | Purpose |
|--------|---------|---------|
| `VITE_SUPABASE_URL` | scrape.yml, deploy.yml | PostgREST base URL |
| `SUPABASE_SECRET_KEY` | scrape.yml | Service-role key (bypasses RLS) for scraper writes |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | deploy.yml | Browser-safe key baked into SPA bundle |
| `ANTHROPIC_API_KEY` | scrape.yml (opt-in) | LLM enrichment via enrich.py |
| `MOTHERDUCK_TOKEN` | scrape.yml (opt-in) | Optional MotherDuck snapshot mirror |
| `SOLDCOMPS_API_KEY` | scrape.yml | eBay sold-price lookups via SoldComps |
