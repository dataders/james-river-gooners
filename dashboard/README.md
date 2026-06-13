# Admin monitoring dashboard (prefab-ui → private storage)

An owner-only operational dashboard for the Gooners stack, in the spirit of
[`dataders/fusion_issue_analysis`](https://github.com/dataders/fusion_issue_analysis)
(the [dashboard bakeoff](https://dashboard-bakeoff.anders.omg.lol/)). It renders
the dbt marts in MotherDuck with [`prefab-ui`](https://pypi.org/project/prefab-ui/)
to a single self-contained HTML file, then serves it **only** to the signed-in
owner.

## What it shows

Four tabs, one per mart domain (`dbt/models/marts/`):

| Tab | Source marts | Highlights |
| --- | --- | --- |
| **Engineering / CI** | `gooners_engineering.*` (from `github_stats` in MotherDuck) | open issues/PRs, avg time-to-merge, CI failure rate, per-workflow reliability + run-time, daily failure-rate trend, scraper throughput |
| **Operations & Cost** | `gooners_operations.*` | Supabase host load & DB reliability, per-source scrape SLA (enrichment / eBay / Cannon's coverage, silent-failure watch), API spend (cumulative + 30-day burn) |
| **Resale Intelligence** | `gooners.fct_enrichment_coverage` / `fct_ebay_comp_coverage` / `fct_price_accuracy` | enrichment coverage per auction, eBay comp coverage, comp accuracy vs realised hammer price |
| **Product & Users** | `gooners.fct_posthog_engagement` / `fct_user_engagement` / `fct_item_engagement` | PostHog DAU / searches / item-opens, users by engagement tier, top items by net favorites |

Every section degrades to an **"awaiting first refresh"** note if its mart isn't
populated yet, so the dashboard never breaks — it fills in as the upstream
pipelines come online (the Supabase-platform metrics need `supabase_stats/`, and
the PostHog tab needs `scraper/posthog_export.py`).

## Access model — owner-only, real auth

`prefab export` bakes the data **inline** into the HTML, so a public URL would
leak it. Instead the data stays behind Supabase auth, mirroring the existing
"members-only resale intelligence" gates:

1. The build workflow uploads `admin.html` → a **private** Supabase Storage
   bucket (`admin-dashboard/latest.html`) with the service key.
2. A Storage RLS policy (`supabase/migrations/0020_admin_dashboard.sql`) lets
   **only the owner's email** read objects in that bucket. Anyone else — logged
   out or a different user — reads zero objects.
3. The SPA's `/admin` route (`src/admin-entry.jsx` → `src/components/AdminDashboard.jsx`,
   a separate Vite entry → `dist/admin/index.html`) signs the owner in,
   downloads the object with their session, and renders it in an iframe. The
   data never ships in the public bundle.

Live at **`https://gooners.anders.omg.lol/admin/`** (sign in as the owner).

## Build & deploy

Hourly via [`.github/workflows/admin-dashboard.yml`](../.github/workflows/admin-dashboard.yml):
PostHog export → `dbt build` → `prefab` render → upload. Run it on demand with
`gh workflow run admin-dashboard.yml --repo dataders/james-river-gooners`.

## Run locally

```bash
cd dashboard
# Render against MotherDuck (engineering data is always live; other domains
# show "awaiting refresh" until dbt build has populated them):
MOTHERDUCK_TOKEN=... uv run --with 'prefab-ui>=0.19.0' --with 'duckdb==1.5.2' --with pytz \
    python app.py -o dist/admin.html

# Preview it in a browser:
python3 -m http.server -d dist 8099   # → http://localhost:8099/admin.html

# Upload to the private bucket (owner-only thereafter):
SUPABASE_URL=... SUPABASE_SECRET_KEY=sb_secret_... \
    uv run --with requests python upload.py dist/admin.html
```

## Files

- `app.py` — queries the marts and renders the prefab HTML (defensive: a missing
  mart → "awaiting refresh", never a crash).
- `upload.py` — uploads the HTML to the private Storage bucket (service key).
- `dist/` — build output (gitignored; never committed — it contains data).
