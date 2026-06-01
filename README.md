# James River Gooners

A better way to browse [Cannon's Auctions](https://bid.cannonsauctions.com/)
(Richmond, VA) and other local estate auctions. A scheduled scraper pulls
listings into a static read model; a React single-page app renders them with
fast filtering, keyword + semantic search, eBay price comps, and deal detection.

🔗 **Live site:** https://cannonsbrowser.com (GitHub Pages + custom domain)

The site is fully static — there is no backend server. Everything the browser
needs is committed to `public/data/` and served from Pages. The "backend" is a
GitHub Action that re-scrapes hourly and commits fresh data.

---

## How it works

```
        INGEST                 READ MODEL (static, on Pages)        BROWSER
        (scrapers)

Maxanet ─► scrape.py     ──┐   public/data/manifest.json        ┌─► React SPA
HiBid   ─► scrape_hibid.py ─┼─► public/data/items/*.ndjson      ─┤   (one loader
eBay    ─► ebay_comps.py  ──┘   public/data/ebay-comps/*.json   └─►  convention)
                               (+ *.parquet / *.embeddings sidecars)

                  [SnapshotSink] ─► MotherDuck (optional analytics mirror)
```

- **Ingest** (`scraper/`) — Python scripts discover current auctions, parse
  listing HTML, normalize categories, and write per-auction files.
- **Read model** (`public/data/`) — the only thing the frontend reads. One
  manifest + per-auction files, loaded through a shared fetch utility. Works
  with zero backend config; the browser never sees a warehouse token.
- **Warehouse** (optional) — append-only historical snapshots in MotherDuck,
  reached only through the `SnapshotSink` seam in `scraper/warehouse.py`. Never
  on the critical path for serving the site.

See [`docs/data-architecture.md`](docs/data-architecture.md) for the full
data-flow contract and the planned MotherDuck → Supabase migration path.

### What the browser actually reads

The SPA fetches the **NDJSON** sidecar for each auction and the comps JSON for
each visible auction — there is no Parquet or Arrow in the browser. Parquet is
still written next to each NDJSON file, but only as the source the scraper reads
back to build manifests and the columnar artifact mirrored to the warehouse.

---

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | Vite 8, React 19, `minisearch` (keyword), `@xenova/transformers` (CLIP semantic search), `react-masonry-css` |
| Scraper | Python 3.11+, `requests` + `beautifulsoup4`, `pyarrow`, `pyyaml`; optional `duckdb`, `sentence-transformers` + `pillow` |
| Data | NDJSON (served) + Parquet (warehouse/manifest source) + JSON comps; optional CLIP `.embeddings` binaries |
| Hosting / CI | GitHub Pages + GitHub Actions |

---

## Getting started

### Frontend

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # production build → dist/
npm run lint       # eslint
```

The dev server reads the data committed in `public/data/`, so the app works
offline with the last-scraped snapshot.

### Scraper

The scraper uses [`uv`](https://docs.astral.sh/uv/) — **never** pip. Run from
the `scraper/` directory.

```bash
cd scraper

# Re-scrape everything (auto-discovers Maxanet + HiBid auctions)
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml \
  python3 rescrape_all.py

# Scrape a single Maxanet auction (URL must include all query params —
# Maxanet redirects to the homepage without AuctionId/Title/etc.)
uv run --with requests --with beautifulsoup4 --with pyarrow --with pyyaml \
  python3 scrape.py "<full_auction_url>"
```

Optional pipelines (opt-in via env vars):

```bash
# Mirror snapshots to MotherDuck (requires MOTHERDUCK_TOKEN)
GOONERS_MOTHERDUCK_SNAPSHOTS=1 uv run --with requests --with beautifulsoup4 \
  --with pyarrow --with pyyaml --with 'duckdb==1.5.2' \
  python3 scrape.py "<full_auction_url>"

# Generate CLIP embeddings for semantic search
# (first run downloads ~350 MB of model weights to ~/.cache/huggingface)
GOONERS_EMBEDDINGS=1 uv run --with requests --with beautifulsoup4 \
  --with pyarrow --with pyyaml --with sentence-transformers --with pillow \
  python3 scrape.py "<full_auction_url>"
```

---

## Project layout

```
src/                     React SPA
  App.jsx                Root: orchestrates the filtering pipeline
  components/            UI (cards, grid, filters, detail modal, ROI calc…)
  hooks/                 Data loading, search, favorites, prefs, theme…
  utils/                 Pure helpers (filters, roiCalc, net, manifest…) + unit tests
  workers/               CLIP text-encoder web worker
scraper/                 Python ingest
  rescrape_all.py        Orchestrator: discover → scrape → archive → manifest
  scrape.py              Maxanet (Cannon's) scraper
  scrape_hibid.py        HiBid scraper
  ebay_comps.py          eBay sold-comps fetcher (budgeted)
  categories.py + category_mappings.yml   Category normalization
  dates.py               Centralized timestamp parsing
  warehouse.py           SnapshotSink seam (MotherDuck today, Supabase later)
  test_*.py              pytest suite
public/data/             The static read model (committed by the scraper Action)
tests/e2e/               Playwright end-to-end tests
docs/data-architecture.md  Source of truth for data flow
```

---

## Testing

```bash
npm run test:unit          # frontend utils (node:test)
npm run test:unit:coverage # …with coverage report
npm run test:e2e           # Playwright (auto-starts the dev server)
npm test                   # unit + e2e

# Scraper tests
cd scraper && uv run --with requests --with beautifulsoup4 --with pyarrow \
  --with pyyaml --with 'duckdb==1.5.2' --with numpy --with pytest python -m pytest -q
```

A pre-commit hook (`.githooks/pre-commit`, wired via the `prepare` npm script)
runs lint + frontend unit tests before each commit. E2E and scraper tests run in
CI.

---

## CI / automation

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `test.yml` | PRs + push to `main` | Lint, frontend unit tests, scraper pytest, Playwright E2E |
| `deploy.yml` | After **Test** succeeds on `main` (or manual) | Build + deploy to GitHub Pages — gated on a green test run |
| `scrape.yml` | Hourly cron + manual | Re-scrape, refresh comps, commit `public/data/` |
| `ebay-comps.yml` | Manual | Isolated eBay comps refresh |
| `comps-smoke.yml` | Weekly + manual | Canary: detect silent eBay-comps regressions |

---

## Key constraints & gotchas

- **Use `uv`, never pip/pip3** for the scraper.
- **Auction URLs must include all query params** (`AuctionId`, `Title`, …) —
  Maxanet redirects to the homepage otherwise.
- **The browser never receives a warehouse token.** Anything requiring a token
  (MotherDuck) runs only in the scraper / CI.
- **Date parsing is centralized** in `scraper/dates.py` — don't copy
  `DATE_PATTERNS` elsewhere.
- **No `duckdb` imports outside `scraper/warehouse.py`** — all warehouse access
  goes through `SnapshotSink`.
- **Custom domain** (`public/CNAME` → `cannonsbrowser.com`) means the site is
  served from the root, so vite uses `base: '/'`.

For agent/Claude-specific notes, see [`CLAUDE.md`](CLAUDE.md).
