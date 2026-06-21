# Photo Resale Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the one-shot photo identifier into a progressive "resale report" — snap a photo and get the item identified, real eBay sold comps, local Cannon's/HiBid/Rasmus sold history, and an estimated value, all with clickable links.

**Architecture:** Client orchestrates three stages that fill in fastest→slowest. Stage 1 extends the existing `image-search` edge function (Haiku vision → enrichment subset). On its return the client fans out two parallel calls: Stage 2 `resale-ebay` (live SoldComps keyword search, real prices) and Stage 3 `resale-embed` (text-only Nomic embedding → two new `*_by_vector` pgvector RPCs for corpus eBay comps + local sold history). The modal renders each section as it lands. Vision embedding is deferred to a later increment. Members-only throughout.

**Tech Stack:** Supabase Postgres + pgvector (migrations), Supabase Edge Functions (Deno/TypeScript), HuggingFace Inference API (`nomic-embed-text-v1.5`), SoldComps API, React 19 + Vite + TanStack Query frontend. Tests: `node --test` for pure JS/TS logic (mirrors `cannon-proxy/parsers.js` + `src/utils/*.test.js`); vitest for components.

**Spec:** `docs/superpowers/specs/2026-06-20-photo-resale-report-design.md`

**Conventions to honor (from CLAUDE.md):**
- Migrations are additive, named `NNNN_description.sql` (next is `0038`). Apply via Supabase MCP `apply_migration`.
- The new `*_by_vector` RPCs return members-only sold prices → **`SECURITY DEFINER`, granted to `authenticated, service_role` ONLY — never `anon`**.
- New edge functions JWT-gate like `image-search` (verify `auth.getUser(token)` with the service-role client), **not** like `embed-query` (anon, no auth).
- Pure logic goes in a sibling `.ts`/`.js` module tested with `node --test`; `index.ts` stays thin glue verified by deploy.
- New frontend logic prefers `.ts`; every `.js` is type-checked unless `// @ts-nocheck` (drive toward 0 — see ratchets). Existing comp utils are `// @ts-nocheck` .js; new pure utils should be `.ts`.
- UI changes need mobile (375×667) + desktop (1280×800) Playwright screenshots before merge.
- Add a user-facing changelog entry (`src/data/changelog.js` + `CHANGELOG.md`) with a fresh `id`.

---

## File structure

**Create:**
- `supabase/migrations/0038_resale_report_rpcs.sql` — `match_sold_listings_by_vector`, `match_cannons_comps_by_vector`, `resale_scan_log` table + `record_resale_scan` atomic cap RPC.
- `supabase/functions/resale-ebay/index.ts` — Stage 2 edge fn (glue).
- `supabase/functions/resale-ebay/soldcomps.ts` — pure: build params, parse provider response → comp rows, status decision.
- `supabase/functions/resale-embed/index.ts` — Stage 3 edge fn (glue).
- `supabase/functions/resale-embed/embed.ts` — pure: text-embed normalization + RPC row → camelCase mappers.
- `supabase/functions/_shared/auth.ts` — shared JWT-gate helper (extracted so all three functions share one verified pattern).
- `src/utils/imageDownscale.ts` — client-side photo downscale before upload.
- `src/utils/resaleReport.ts` — pure: merge/dedupe/re-sort eBay rows, estimate computation, enrichment-subset → search-term helpers.
- `src/utils/resaleReport.test.js` — `node --test` for `resaleReport.ts`.
- `src/utils/soldcomps.test.js` — `node --test` for `resale-ebay/soldcomps.ts` pure logic.
- `src/hooks/useResaleReport.js` — staged TanStack Query orchestrator (replaces `useImageSearch` internals).
- `scraper/test_enrich_schema_parity.py` — asserts the Stage-1 TS tool schema fields ⊆ `enrich.py` schema.

**Modify:**
- `supabase/functions/image-search/index.ts` — extend `identify_item` tool schema to the report subset; reuse `_shared/auth.ts`.
- `src/components/ImageSearchModal.jsx` — three progressive sections, reuse `EbayComps`/`CannonsComps`.
- `src/data/changelog.js`, `CHANGELOG.md` — release note.

**Reuse unchanged:** `src/components/EbayComps.jsx`, `src/components/CannonsComps.jsx`, `src/utils/ebayComps.js` (`buildEbaySoldSearches`, `normalizeEbaySoldMatches`, `buildEbaySoldSearchUrl`), `src/utils/cannonsComps.js` (`normalizeCannonsComps`, `getCannonsCompMedian`).

**Data shapes the UI expects (so edge fns emit matching JSON):**
- `EbayComps` consumes `soldComps = { searchUrl, matches: [...] }`; `normalizeEbaySoldMatches` reads each match's `{ title, price: {value, currency}, soldDate, soldDateLabel, thumbnailUrl, itemWebUrl, condition, shippingLabel }` (it derives `priceLabel` via `formatSoldCompPrice`, which wants `comp.price.value`/`comp.price.currency`). **Stage 2/3 must emit matches in this camelCase shape.**
- `CannonsComps` consumes `comps = { matches: [...] }`; `normalizeCannonsComps` reads `{ title, soldPrice, soldDate, source, thumbnailUrl, detailUrl }`. **Stage 3 must map the RPC's snake_case rows to this.**

---

## Phase A — SQL migrations

### Task A1: `match_sold_listings_by_vector` + `match_cannons_comps_by_vector` + scan-log

**Files:**
- Create: `supabase/migrations/0038_resale_report_rpcs.sql`

These are arbitrary-vector variants of `match_sold_listings` (0027) and `match_cannons_comps` (0014): same body, but the source vector is a parameter instead of looked up from `nomic_embeddings` by `(auction, item)`. No `item_id` in the output (no source lot). Grants are `authenticated, service_role` only.

- [ ] **Step 1: Write the migration**

```sql
-- 0038_resale_report_rpcs.sql
-- Photo resale report (spec 2026-06-20): arbitrary-vector comp matching for a
-- user-supplied photo (no source auction lot), plus a per-user daily scan cap.

-- eBay sold-listings corpus, matched by an arbitrary 768-dim query vector.
-- Mirror of match_sold_listings (0027) without the (auction,item) source lookup.
create or replace function match_sold_listings_by_vector(
  query_embedding vector(768),
  match_count int default 8,
  min_sim float default 0.75
)
returns table (
  ebay_item_id text,
  similarity float,
  title text,
  sold_price numeric,
  sold_date date,
  sold_date_label text,
  condition text,
  thumbnail_url text,
  item_web_url text
)
language sql stable security definer
set search_path = public
set statement_timeout to '30s'
as $$
  select
    sl.ebay_item_id,
    1 - (e.embedding <=> query_embedding) as similarity,
    sl.title, sl.sold_price, sl.sold_date, sl.sold_date_label,
    sl.condition, sl.thumbnail_url, sl.item_web_url
  from sold_listing_embeddings e
  join sold_listings sl on sl.ebay_item_id = e.ebay_item_id
  where 1 - (e.embedding <=> query_embedding) >= min_sim
  order by e.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

grant execute on function match_sold_listings_by_vector(vector, int, float)
  to authenticated, service_role;

-- Local sold history (Cannon's/HiBid/Rasmus), matched by an arbitrary vector.
-- Mirror of match_cannons_comps (0014) without the own-auction exclusion (there
-- is no source lot). sold_lots is already archive-only + final_bid>0, so a live
-- lot can't surface as its own comp.
create or replace function match_cannons_comps_by_vector(
  query_embedding vector(768),
  match_count int default 5,
  min_sim float default 0.75
)
returns table (
  comp_auction_safe_id text,
  comp_item_id text,
  similarity float,
  title text,
  sold_price numeric,
  sold_at timestamptz,
  image_url text,
  detail_url text,
  auction_title text,
  source text
)
language sql stable security definer
set search_path = public
set statement_timeout to '30s'
as $$
  select
    s.auction_safe_id, s.item_id,
    1 - (n.embedding <=> query_embedding) as similarity,
    s.title, s.final_bid, s.sold_at, s.image_url, s.detail_url,
    s.auction_title, s.source
  from nomic_embeddings n
  join sold_lots s
    on s.auction_safe_id = n.auction_safe_id and s.item_id = n.item_id
  where s.final_bid is not null and s.final_bid > 0
    and 1 - (n.embedding <=> query_embedding) >= min_sim
  order by n.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

grant execute on function match_cannons_comps_by_vector(vector, int, float)
  to authenticated, service_role;

-- Per-user daily scan ledger + atomic cap. record_resale_scan inserts a row and
-- returns whether the user is still under the daily cap, in one statement (no
-- read-then-write race). Returns true when the call is allowed to hit the paid API.
create table if not exists resale_scan_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists resale_scan_log_user_day
  on resale_scan_log (user_id, created_at);
alter table resale_scan_log enable row level security;
-- No policies: only the service-role edge fn writes/reads (bypasses RLS).

create or replace function record_resale_scan(
  p_user_id uuid,
  daily_cap int default 50
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  used int;
begin
  insert into resale_scan_log (user_id) values (p_user_id);
  select count(*) into used
  from resale_scan_log
  where user_id = p_user_id and created_at >= now() - interval '1 day';
  return used <= daily_cap;
end;
$$;

grant execute on function record_resale_scan(uuid, int) to service_role;

-- Retention: keep the ledger small. (Run from a scheduled job or the daily
-- scrape; documented here so it isn't forgotten.)
-- delete from resale_scan_log where created_at < now() - interval '7 days';
```

- [ ] **Step 2: Apply the migration** via Supabase MCP `apply_migration` (name `0038_resale_report_rpcs`, the SQL above). Applying early is safe — additive, invisible to the current frontend.

- [ ] **Step 3: Smoke-test the RPCs with a real vector.** Via Supabase MCP `execute_sql`, grab one corpus vector and confirm the function returns rows:

```sql
select count(*) from (
  select * from match_sold_listings_by_vector(
    (select embedding from sold_listing_embeddings limit 1), 8, 0.5)
) t;
```
Expected: ≥ 1 row (the seed vector matches itself at similarity 1.0). Repeat for `match_cannons_comps_by_vector` using a `nomic_embeddings` vector. Confirm `record_resale_scan('<a real auth uid>'::uuid, 50)` returns `true`.

- [ ] **Step 4: Confirm the anon gate holds.** Via `execute_sql` impersonating anon is not directly possible through MCP (service-role), so instead assert the grant: 

```sql
select has_function_privilege('anon',
  'match_sold_listings_by_vector(vector,int,float)', 'execute');
```
Expected: `false`. Repeat for `match_cannons_comps_by_vector`. (If `true`, the grant is wrong — fix before proceeding; this is the members-only gate.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0038_resale_report_rpcs.sql
git commit -m "feat(db): arbitrary-vector comp RPCs + resale scan cap for photo report"
```

---

## Phase B — Stage 1: extend `image-search` + shared auth

### Task B1: Extract shared JWT-gate helper

**Files:**
- Create: `supabase/functions/_shared/auth.ts`
- Modify: `supabase/functions/image-search/index.ts:30-58` (replace inline auth with the helper)

- [ ] **Step 1: Write `_shared/auth.ts`** — pull the exact pattern already in `image-search/index.ts:30-50`:

```ts
// Shared JWT gate for members-only edge functions.
// Returns the authenticated user, or a ready-to-send 401 Response.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// Verify the Bearer token belongs to an authenticated user.
// Returns { user } on success or { response } (a 401) on failure.
export async function requireUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { response: jsonResponse({ error: 'Unauthorized' }, 401) }
  }
  const supabase = serviceClient()
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return { response: jsonResponse({ error: 'Unauthorized' }, 401) }
  }
  return { user, supabase, token }
}
```

- [ ] **Step 2: Refactor `image-search/index.ts`** to use `requireUser`, `CORS_HEADERS`, `jsonResponse` from `../_shared/auth.ts`. Behavior must be identical (still returns 401 unauth, 503 missing key). No test framework for the glue — verify by reading the diff for equivalence.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/auth.ts supabase/functions/image-search/index.ts
git commit -m "refactor(edge): extract shared JWT-gate helper, adopt in image-search"
```

### Task B2: Extend `identify_item` to the report subset + parity test

**Files:**
- Modify: `supabase/functions/image-search/index.ts` (tool schema)
- Create: `scraper/test_enrich_schema_parity.py`

The report needs: `searchQuery` (keys Stages 2/3), `brand`, `model`, `productType`, `condition` (enum), `brandConfidence`, `modelConfidence` — plus the existing `category`, `description`, `estimatedValue`, `keywords` (keep, harmless). Field names must match `enrich.py` so the parity test passes and the embedded-text path stays consistent.

- [ ] **Step 1: Write the failing parity test** (`scraper/test_enrich_schema_parity.py`):

```python
"""The image-search edge fn's tool schema must be a subset of enrich.py's schema,
so the photo report's identification fields line up with the scraper's enrichment."""
import json, re
from pathlib import Path

# The canonical enrichment field set (search-oriented v3/v6 fields the report uses).
EXPECTED_SUBSET = {
    "brand", "modelOrSku", "productType", "searchQuery", "condition",
    "brandConfidence", "modelConfidence",
}

def test_edge_schema_fields_are_enrichment_fields():
    # enrich.py is the source of truth for the field names.
    enrich_src = (Path(__file__).parent / "enrich.py").read_text()
    for field in EXPECTED_SUBSET:
        assert f'"{field}"' in enrich_src, f"{field} missing from enrich.py"

    # The edge fn must declare exactly these names (model -> modelOrSku alias allowed).
    edge_src = (Path(__file__).parents[1] / "supabase/functions/image-search/index.ts").read_text()
    props = set(re.findall(r"^\s{12}(\w+):\s*\{", edge_src, re.M))
    # searchQuery, productType, condition, brand, brandConfidence, modelConfidence present
    for field in {"brand", "productType", "searchQuery", "condition",
                  "brandConfidence", "modelConfidence"}:
        assert field in props, f"edge tool schema missing {field}; props={props}"
```

- [ ] **Step 2: Run it — expect FAIL** (edge schema lacks `searchQuery`/`productType`/confidences):

Run: `cd scraper && uv run --with pytest pytest test_enrich_schema_parity.py -v`
Expected: FAIL.

- [ ] **Step 3: Extend the tool schema** in `image-search/index.ts`. Add to `properties` (keep existing fields):

```ts
            productType: {
              type: 'string',
              description: 'The plain noun for what this is (e.g. "cordless drill", "credenza"). Empty string if unclear.',
            },
            searchQuery: {
              type: 'string',
              description: 'The single best eBay sold-listings search phrase: brand + model + product type + one key attribute. Unquoted. This is what we search eBay with.',
            },
            condition: {
              type: 'string',
              enum: ['new', 'open_box', 'used', 'for_parts', ''],
              description: 'Item condition. Empty string if not determinable.',
            },
            brandConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', ''],
              description: 'Confidence in the brand identification.',
            },
            modelConfidence: {
              type: 'string',
              enum: ['high', 'medium', 'low', ''],
              description: 'Confidence in the model identification.',
            },
```
Add `productType`, `searchQuery`, `condition`, `brandConfidence`, `modelConfidence` to the `required` array. Update the function's header comment (the `Returns:` line) to list the new fields. Update the prompt text to ask for a strong `searchQuery`.

- [ ] **Step 4: Run the parity test — expect PASS.**

Run: `cd scraper && uv run --with pytest pytest test_enrich_schema_parity.py -v`
Expected: PASS.

- [ ] **Step 5: Deploy + manual smoke** via Supabase MCP `deploy_edge_function` (function `image-search`). Then from the app (signed in) snap/upload one photo and confirm the response now includes a non-empty `searchQuery`. (No automated harness for the live Claude call.)

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/image-search/index.ts scraper/test_enrich_schema_parity.py
git commit -m "feat(edge): image-search returns resale searchQuery + condition + confidences"
```

---

## Phase C — Stage 2: `resale-ebay` (live SoldComps)

### Task C1: Pure SoldComps logic (`soldcomps.ts`) — TDD

**Files:**
- Create: `supabase/functions/resale-ebay/soldcomps.ts`
- Create: `src/utils/soldcomps.test.js` (imports the pure module; `node --test`)

Port only the parse + param-build from `scraper/ebay_fetch.py:soldcomps_item_match` / `soldcomps_sold_matches`. **Keyword query only** (no tiered funnel). Output matches the UI's camelCase shape (`price: {value, currency}`).

- [ ] **Step 1: Write the failing test** (`src/utils/soldcomps.test.js`):

```js
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSoldcompsParams, parseSoldcompsItems, decideStatus } from '../../supabase/functions/resale-ebay/soldcomps.ts'

test('buildSoldcompsParams sends keyword only by default', () => {
  assert.deepEqual(buildSoldcompsParams('Dewalt DCD777 drill'), { keyword: 'Dewalt DCD777 drill' })
})

test('buildSoldcompsParams adds categoryId when provided', () => {
  assert.deepEqual(buildSoldcompsParams('x', '11700'), { keyword: 'x', categoryId: '11700' })
})

test('parseSoldcompsItems maps + dedupes by url, drops items missing title/price/url', () => {
  const items = [
    { itemId: '1', title: 'A', soldPrice: '50.00', soldCurrency: 'USD', url: 'https://www.ebay.com/itm/1', endedAt: '2026-05-01', imageUrl: 'i', condition: 'Used' },
    { itemId: '1b', title: 'A dup', soldPrice: '60', url: 'https://www.ebay.com/itm/1' }, // dup url
    { title: 'no url', soldPrice: '9' },                                                  // dropped
    { title: 'no price', url: 'https://www.ebay.com/itm/2' },                             // dropped
  ]
  const rows = parseSoldcompsItems(items)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].price, { value: '50.00', currency: 'USD' })
  assert.equal(rows[0].itemWebUrl, 'https://www.ebay.com/itm/1')
  assert.equal(rows[0].ebayItemId, '1')
  assert.equal(rows[0].soldDateLabel, '2026-05-01' /* or formatted; assert non-empty */ ? rows[0].soldDateLabel : rows[0].soldDateLabel)
})

test('decideStatus', () => {
  assert.equal(decideStatus(401, []), 'live_error')
  assert.equal(decideStatus(200, []), 'no_results')
  assert.equal(decideStatus(200, [{}]), 'ok')
})
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

Run: `npm run test:unit` (or `node --test src/utils/soldcomps.test.js`)
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `soldcomps.ts`:**

```ts
// Pure SoldComps helpers for the resale-ebay edge function. Keyword-query only
// (no build_ebay_sold_searches funnel). Output matches the UI's camelCase shape.
const ITEM_URL_RE = /ebay\.com\/itm\/(\d+)/

export function buildSoldcompsParams(query: string, categoryId?: string): Record<string, string> {
  const params: Record<string, string> = { keyword: query }
  if (categoryId) params.categoryId = categoryId
  return params
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : (typeof v === 'number' ? String(v) : fallback)
}

export interface CompRow {
  ebayItemId: string
  title: string
  price: { value: string; currency: string }
  soldDate: string
  soldDateLabel: string
  thumbnailUrl: string
  itemWebUrl: string
  condition: string
}

export function parseSoldcompsItems(items: unknown[]): CompRow[] {
  const out: CompRow[] = []
  const seen = new Set<string>()
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    const url = text(it.url ?? it.itemUrl ?? it.itemWebUrl)
    const title = text(it.title)
    const priceValue = text(it.soldPrice ?? it.price ?? it.priceValue)
    if (!url || !title || !priceValue) continue
    if (seen.has(url)) continue
    seen.add(url)
    const ended = text(it.endedAt ?? it.soldAt ?? it.soldDate)
    out.push({
      ebayItemId: text(it.itemId ?? it.ebayItemId) || (url.match(ITEM_URL_RE)?.[1] ?? ''),
      title,
      price: { value: priceValue, currency: text(it.soldCurrency ?? it.currency, 'USD') },
      soldDate: ended,
      soldDateLabel: ended ? new Date(ended).toLocaleDateString() : '',
      thumbnailUrl: text(it.imageUrl ?? it.thumbnailUrl ?? it.image),
      itemWebUrl: url,
      condition: text(it.condition),
    })
  }
  return out
}

export type ScanStatus = 'ok' | 'over_cap' | 'live_error' | 'no_results'

export function decideStatus(httpStatus: number, rows: unknown[]): ScanStatus {
  if (httpStatus >= 400) return 'live_error'
  return rows.length > 0 ? 'ok' : 'no_results'
}
```

(Adjust the `soldDateLabel` assertion in the test to match the chosen formatting.)

- [ ] **Step 4: Run — expect PASS.**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/resale-ebay/soldcomps.ts src/utils/soldcomps.test.js
git commit -m "feat(edge): pure SoldComps parse/params/status for resale-ebay"
```

### Task C2: `resale-ebay/index.ts` glue

**Files:**
- Create: `supabase/functions/resale-ebay/index.ts`

- [ ] **Step 1: Implement the function:**

```ts
// resale-ebay — Stage 2 of the photo resale report. Live SoldComps keyword
// search for the identified product, with an atomic per-user daily cap and a
// smart-link fallback. Members-only (JWT-gated).
//
// POST body: { searchQuery: string, categoryId?: string }
// Returns:   { status, matches, searchUrl }   (matches = CompRow[])
//
// Secrets: SOLDCOMPS_API_KEY (+ optional SOLDCOMPS_API_URL), SUPABASE_*.
import { requireUser, jsonResponse, CORS_HEADERS } from '../_shared/auth.ts'
import { buildSoldcompsParams, parseSoldcompsItems, decideStatus } from './soldcomps.ts'

const SOLDCOMPS_URL = Deno.env.get('SOLDCOMPS_API_URL') ?? 'https://api.sold-comps.com/v1/scrape'
const DAILY_CAP = 50

// eBay "Sold & Completed" search URL — the smart-link fallback (mirrors ebayComps.js).
function soldSearchUrl(query: string): string {
  const u = new URL('https://www.ebay.com/sch/i.html')
  u.searchParams.set('_nkw', query)
  u.searchParams.set('LH_Sold', '1')
  u.searchParams.set('LH_Complete', '1')
  return u.toString()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const auth = await requireUser(req)
  if ('response' in auth) return auth.response
  const { user, supabase } = auth

  let body: { searchQuery?: string; categoryId?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const query = (body.searchQuery ?? '').trim()
  if (!query) return jsonResponse({ status: 'no_results', matches: [], searchUrl: null })

  const searchUrl = soldSearchUrl(query)
  const apiKey = Deno.env.get('SOLDCOMPS_API_KEY')

  // Atomic cap: record + check in one RPC.
  const { data: allowed } = await supabase.rpc('record_resale_scan', { p_user_id: user.id, daily_cap: DAILY_CAP })
  if (allowed === false || !apiKey) {
    return jsonResponse({ status: allowed === false ? 'over_cap' : 'live_error', matches: [], searchUrl })
  }

  try {
    const params = new URLSearchParams(buildSoldcompsParams(query, body.categoryId))
    const res = await fetch(`${SOLDCOMPS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'james-river-gooners/1.0' },
      signal: AbortSignal.timeout(25_000),
    })
    const payload = res.ok ? await res.json() : {}
    const items = payload.items ?? payload.results ?? []
    const matches = parseSoldcompsItems(items).slice(0, 8)
    return jsonResponse({ status: decideStatus(res.status, matches), matches, searchUrl })
  } catch (err) {
    console.error('resale-ebay error:', err)
    return jsonResponse({ status: 'live_error', matches: [], searchUrl })
  }
})
```

- [ ] **Step 2: Deploy** via Supabase MCP `deploy_edge_function` (function `resale-ebay`). Confirm `SOLDCOMPS_API_KEY` is set in edge-function secrets (it's a GH Actions secret; the edge runtime needs its own copy — set via Supabase dashboard/CLI if absent; if absent the function returns `live_error` + smart link, which is a safe degrade).

- [ ] **Step 3: Manual smoke** — signed in, `supabase.functions.invoke('resale-ebay', { body: { searchQuery: 'Dewalt DCD777' } })` from the browser console returns `{ status, matches, searchUrl }`. Verify `over_cap` path by lowering `DAILY_CAP` temporarily or inspecting `resale_scan_log`.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/resale-ebay/index.ts
git commit -m "feat(edge): resale-ebay live SoldComps with per-user cap + smart-link fallback"
```

---

## Phase D — Stage 3: `resale-embed` (text-only)

### Task D1: Pure embed/map logic (`embed.ts`) — TDD

**Files:**
- Create: `supabase/functions/resale-embed/embed.ts`
- Create: covered by `src/utils/resaleReport.test.js` (Task E1) — add embed-mapper tests there, or a dedicated `src/utils/resaleEmbed.test.js`.

- [ ] **Step 1: Write the failing test** (`src/utils/resaleEmbed.test.js`):

```js
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { l2normalize, mapSoldListingRows, mapCannonsRows } from '../../supabase/functions/resale-embed/embed.ts'

test('l2normalize returns a unit vector', () => {
  const v = l2normalize([3, 4])
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9)
  assert.ok(Math.abs(v[0] - 0.6) < 1e-9)
})

test('mapSoldListingRows -> UI camelCase with price object', () => {
  const rows = [{ ebay_item_id: '1', similarity: 0.9, title: 'A', sold_price: 50, sold_date: '2026-05-01', sold_date_label: 'May 1', condition: 'Used', thumbnail_url: 't', item_web_url: 'https://www.ebay.com/itm/1' }]
  const out = mapSoldListingRows(rows)
  assert.deepEqual(out[0].price, { value: 50, currency: 'USD' })
  assert.equal(out[0].itemWebUrl, 'https://www.ebay.com/itm/1')
  assert.equal(out[0].similarity, 0.9)
})

test('mapCannonsRows -> CannonsComps shape', () => {
  const rows = [{ comp_item_id: 'x', similarity: 0.8, title: 'B', sold_price: 99, sold_at: '2026-04-01T00:00:00Z', image_url: 'i', detail_url: 'd', auction_title: 'AT', source: 'cannons' }]
  const out = mapCannonsRows(rows)
  assert.equal(out[0].soldPrice, 99)
  assert.equal(out[0].thumbnailUrl, 'i')
  assert.equal(out[0].detailUrl, 'd')
  assert.equal(out[0].source, 'cannons')
})
```

- [ ] **Step 2: Run — expect FAIL.** Run: `node --test src/utils/resaleEmbed.test.js`

- [ ] **Step 3: Implement `embed.ts`:**

```ts
// Pure helpers for resale-embed. Text embedding normalization + RPC row mappers
// to the camelCase shapes EbayComps/CannonsComps consume.
const HF_MODEL = 'nomic-ai/nomic-embed-text-v1.5'

export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map(x => x / norm) : v
}

// Embed a text query exactly as embed-query does (search_query prefix, L2-norm).
export async function embedText(query: string, hfToken: string): Promise<number[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`
  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    { method: 'POST', headers, body: JSON.stringify({ inputs: `search_query: ${query}` }),
      signal: AbortSignal.timeout(20_000) },
  )
  if (!res.ok) throw new Error(`HF ${res.status}: ${await res.text()}`)
  let emb: number[] | number[][] = await res.json()
  if (Array.isArray(emb[0])) emb = (emb as number[][])[0]
  return l2normalize(emb as number[])
}

export function mapSoldListingRows(rows: any[]) {
  return (rows || []).map(r => ({
    ebayItemId: r.ebay_item_id,
    similarity: r.similarity,
    title: r.title,
    price: { value: r.sold_price, currency: 'USD' },
    soldDate: r.sold_date,
    soldDateLabel: r.sold_date_label,
    condition: r.condition,
    thumbnailUrl: r.thumbnail_url,
    itemWebUrl: r.item_web_url,
  }))
}

export function mapCannonsRows(rows: any[]) {
  return (rows || []).map(r => ({
    itemId: r.comp_item_id,
    similarity: r.similarity,
    title: r.title,
    soldPrice: r.sold_price,
    soldDate: r.sold_at,
    thumbnailUrl: r.image_url,
    detailUrl: r.detail_url,
    auctionTitle: r.auction_title,
    source: r.source,
  }))
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `node --test src/utils/resaleEmbed.test.js`

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/resale-embed/embed.ts src/utils/resaleEmbed.test.js
git commit -m "feat(edge): pure text-embed + RPC row mappers for resale-embed"
```

### Task D2: `resale-embed/index.ts` glue

**Files:**
- Create: `supabase/functions/resale-embed/index.ts`

- [ ] **Step 1: Implement:**

```ts
// resale-embed — Stage 3 of the photo resale report. Text-only Nomic embedding
// of the identified searchQuery → corpus eBay comps + local sold history via the
// arbitrary-vector RPCs. Members-only (JWT-gated). Vision leg is a later increment.
//
// POST body: { searchQuery: string }
// Returns:   { ebay: { matches }, cannons: { matches }, error? }
import { requireUser, jsonResponse, CORS_HEADERS } from '../_shared/auth.ts'
import { embedText, mapSoldListingRows, mapCannonsRows } from './embed.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const auth = await requireUser(req)
  if ('response' in auth) return auth.response
  const { supabase } = auth

  let body: { searchQuery?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const query = (body.searchQuery ?? '').trim()
  if (!query) return jsonResponse({ ebay: { matches: [] }, cannons: { matches: [] } })

  try {
    const vec = await embedText(query, Deno.env.get('HUGGINGFACE_TOKEN') ?? '')
    const [sold, cannons] = await Promise.all([
      supabase.rpc('match_sold_listings_by_vector', { query_embedding: vec, match_count: 8, min_sim: 0.75 }),
      supabase.rpc('match_cannons_comps_by_vector', { query_embedding: vec, match_count: 5, min_sim: 0.75 }),
    ])
    return jsonResponse({
      ebay: { matches: mapSoldListingRows(sold.data ?? []) },
      cannons: { matches: mapCannonsRows(cannons.data ?? []) },
    })
  } catch (err) {
    console.error('resale-embed error:', err)
    return jsonResponse({ ebay: { matches: [] }, cannons: { matches: [] }, error: String(err) })
  }
})
```

- [ ] **Step 2: Deploy** via `deploy_edge_function` (function `resale-embed`).

- [ ] **Step 3: Manual smoke** — signed in, `supabase.functions.invoke('resale-embed', { body: { searchQuery: 'mid century walnut credenza' } })` returns `{ ebay: { matches }, cannons: { matches } }`. Confirm rows come back (validates the HF text path + both RPCs end-to-end). **This is the go/no-go for the embedding chain** — if HF text embedding fails here, fix before frontend work.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/resale-embed/index.ts
git commit -m "feat(edge): resale-embed text-only corpus + local-history matching"
```

---

## Phase E — Frontend: orchestration, merge, UI

### Task E1: Pure merge/estimate logic (`resaleReport.ts`) — TDD

**Files:**
- Create: `src/utils/resaleReport.ts`
- Create: `src/utils/resaleReport.test.js`

- [ ] **Step 1: Write the failing test:**

```js
// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeEbayComps, estimateValue } from './resaleReport.ts'

test('mergeEbayComps: corpus (scored, >=min) first by sim desc, then live in order, dedupe by ebayItemId', () => {
  const live = [
    { ebayItemId: '1', title: 'live1', price: { value: '10', currency: 'USD' }, itemWebUrl: 'u1' },
    { ebayItemId: '2', title: 'live2', price: { value: '20', currency: 'USD' }, itemWebUrl: 'u2' },
  ]
  const corpus = [
    { ebayItemId: '2', similarity: 0.95, title: 'corpus2', price: { value: '22', currency: 'USD' }, itemWebUrl: 'u2' },
    { ebayItemId: '3', similarity: 0.80, title: 'corpus3', price: { value: '33', currency: 'USD' }, itemWebUrl: 'u3' },
    { ebayItemId: '4', similarity: 0.50, title: 'belowmin', price: { value: '9', currency: 'USD' }, itemWebUrl: 'u4' },
  ]
  const merged = mergeEbayComps(live, corpus, 0.75)
  // corpus2 (0.95), corpus3 (0.80) first; then live1 (id1, not in corpus); id2 deduped to corpus; id4 dropped (<min)
  assert.deepEqual(merged.map(m => m.ebayItemId), ['2', '3', '1'])
})

test('mergeEbayComps with no corpus returns live as-is', () => {
  const live = [{ ebayItemId: '1', title: 'a', price: { value: '1', currency: 'USD' }, itemWebUrl: 'u1' }]
  assert.deepEqual(mergeEbayComps(live, [], 0.75).map(m => m.ebayItemId), ['1'])
})

test('estimateValue: median + range of merged eBay prices', () => {
  const rows = [
    { price: { value: '10', currency: 'USD' } },
    { price: { value: '20', currency: 'USD' } },
    { price: { value: '30', currency: 'USD' } },
  ]
  const est = estimateValue(rows, [])
  assert.equal(est.median, 20)
  assert.deepEqual([est.low, est.high], [10, 30])
})

test('estimateValue falls back to local-history median when no eBay', () => {
  const est = estimateValue([], [{ soldPrice: 100 }, { soldPrice: 200 }])
  assert.equal(est.median, 150)
})
```

- [ ] **Step 2: Run — expect FAIL.** Run: `node --test src/utils/resaleReport.test.js`

- [ ] **Step 3: Implement `resaleReport.ts`:**

```ts
interface PriceObj { value: string | number; currency?: string }
interface EbayRow { ebayItemId?: string; similarity?: number; price?: PriceObj; [k: string]: unknown }

function priceNum(row: { price?: PriceObj }): number {
  const v = Number(row.price?.value)
  return Number.isFinite(v) ? v : NaN
}

// Corpus rows with similarity >= minSim, sorted desc; then live rows (no score)
// in original order. Dedupe by ebayItemId (corpus wins).
export function mergeEbayComps(live: EbayRow[], corpus: EbayRow[], minSim = 0.75): EbayRow[] {
  const scored = (corpus || [])
    .filter(r => typeof r.similarity === 'number' && r.similarity >= minSim)
    .sort((a, b) => (b.similarity as number) - (a.similarity as number))
  const seen = new Set(scored.map(r => r.ebayItemId).filter(Boolean) as string[])
  const liveOnly = (live || []).filter(r => !r.ebayItemId || !seen.has(r.ebayItemId))
  return [...scored, ...liveOnly]
}

function median(nums: number[]): number | null {
  const s = nums.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (!s.length) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// eBay median+range preferred; else local-history median.
export function estimateValue(ebayRows: EbayRow[], cannonsRows: { soldPrice?: number | string }[]) {
  const ebayPrices = (ebayRows || []).map(priceNum).filter(n => Number.isFinite(n) && n > 0)
  if (ebayPrices.length) {
    const sorted = [...ebayPrices].sort((a, b) => a - b)
    return { median: median(ebayPrices), low: sorted[0], high: sorted[sorted.length - 1], source: 'ebay' as const }
  }
  const local = (cannonsRows || []).map(r => Number(r.soldPrice)).filter(n => Number.isFinite(n) && n > 0)
  if (local.length) return { median: median(local), low: Math.min(...local), high: Math.max(...local), source: 'local' as const }
  return { median: null, low: null, high: null, source: 'none' as const }
}
```

- [ ] **Step 4: Run — expect PASS.** Run: `node --test src/utils/resaleReport.test.js`
- [ ] **Step 5: Commit**

```bash
git add src/utils/resaleReport.ts src/utils/resaleReport.test.js
git commit -m "feat(ui): pure merge/dedupe/estimate logic for resale report"
```

### Task E2: Client-side image downscale

**Files:**
- Create: `src/utils/imageDownscale.ts`

- [ ] **Step 1: Implement** (canvas downscale to max edge ~1024, JPEG ~0.85; returns base64 + mimeType). Keep it a single focused function `downscaleImage(file, maxEdge=1024): Promise<{ base64, mimeType }>`. (No unit test — it's canvas/DOM; verified in the manual UI smoke. If a test is wanted, assert it no-ops on a tiny image via a jsdom canvas stub — optional.)

- [ ] **Step 2: Commit**

```bash
git add src/utils/imageDownscale.ts
git commit -m "feat(ui): client-side photo downscale before upload"
```

### Task E3: Staged orchestrator hook (`useResaleReport`)

**Files:**
- Create: `src/hooks/useResaleReport.js`
- (Keep `useImageSearch.js` until E4 swaps the modal over, then remove if unused.)

- [ ] **Step 1: Implement the hook.** Responsibilities:
  - `analyze(file)`: downscale → invoke `image-search` (Stage 1) → set `identification` (with `searchQuery`).
  - On Stage 1 success, fan out two parallel `supabase.functions.invoke` calls: `resale-ebay` and `resale-embed`, each setting its own loading/result/error state.
  - Expose `{ analyze, clear, identification, idLoading, idError, ebay, ebayLoading, embed, embedLoading }`.
  - Build a `categoryId` for `resale-ebay` only if cheaply derivable from the identified `category` via the existing `EBAY_CATEGORY_IDS` map in `ebayComps.js`; otherwise omit (optional per spec).
  - Use TanStack Query (`useQuery`) keyed on a stable hash of the file/searchQuery so re-renders don't refire, mirroring the codebase's server-state pattern. (A simpler `useState`+`useCallback` triad like the current `useImageSearch` is acceptable if Query keying is awkward for a one-shot action — match whichever the reviewer prefers; the staged fan-out is the requirement, not the library.)

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useResaleReport.js
git commit -m "feat(ui): staged resale-report orchestrator hook (3-stage fan-out)"
```

### Task E4: Progressive modal UI

**Files:**
- Modify: `src/components/ImageSearchModal.jsx`

- [ ] **Step 1: Wire the modal to `useResaleReport`.** After capture/upload → `analyze(file)`. Render three sections, each with skeleton → content:
  1. **Identification** — brand/model/productType/condition + confidence; render as soon as `identification` lands.
  2. **eBay sold comps** — pass merged comps to `<EbayComps item={{...identification}} soldComps={{ searchUrl: ebay?.searchUrl, matches: mergeEbayComps(ebay?.matches, embed?.ebay?.matches, 0.75) }} />`. While `ebayLoading`, show a skeleton; when `embed` lands the merge re-sorts (memoize on both). Show status copy for `over_cap`/`live_error`/`no_results`.
  3. **Local history** — `<CannonsComps comps={{ matches: embed?.ebay ? embed.cannons.matches : [] }} />` (i.e. `embed?.cannons`); skeleton while `embedLoading`.
  - Headline **estimate** from `estimateValue(mergedEbay, embed?.cannons?.matches)`.
  - Each row's clickable link is already built into `EbayComps`/`CannonsComps` (they render `<a href>` to `itemWebUrl`/`detailUrl`). Verify those anchors are present.

- [ ] **Step 2: Lint + type-check.** Run: `npm run lint` and `npx tsc --noEmit` (or `npm run ratchets`). Expected: clean (no new `@ts-nocheck` on new `.ts` files; `resaleReport.ts`/`imageDownscale.ts` type-check).

- [ ] **Step 3: Screenshots (REQUIRED before merge).** `npm run dev`, sign in, drive the modal with Playwright at 375×667 and 1280×800 capturing the three-section report (skeleton + filled). Send to the user; wait for approval (CLAUDE.md rule).

- [ ] **Step 4: Commit**

```bash
git add src/components/ImageSearchModal.jsx
git commit -m "feat(ui): progressive resale report — identification, eBay comps, local history"
```

### Task E5: Changelog + cleanup

**Files:**
- Modify: `src/data/changelog.js` (newest entry first, fresh `id`s), `CHANGELOG.md` (mirror)
- Remove `src/hooks/useImageSearch.js` if no longer referenced (`grep -rn useImageSearch src/`).

- [ ] **Step 1:** Add a dated changelog entry, plain-language, e.g. "Snap a photo of any item to get it identified plus real eBay sold prices and what similar lots sold for locally — with links." Fresh `id` per line.
- [ ] **Step 2:** Run the full unit suite. Run: `npm run test:unit` → PASS. `cd scraper && uv run --with pytest pytest test_enrich_schema_parity.py` → PASS.
- [ ] **Step 3: Commit**

```bash
git add src/data/changelog.js CHANGELOG.md src/hooks/useImageSearch.js
git commit -m "feat(ui): announce photo resale report; remove old image-search hook"
```

---

## Rollout (per CLAUDE.md "Rolling out data-backed migrations")

The corpus tables already exist and are populated by the scraper — this feature only *reads* them, so no pre-merge data backfill is needed. Order:
1. Apply `0038` (Task A1) — additive, safe before merge.
2. Deploy the three edge functions (Tasks B/C/D) — also additive; old frontend never calls them.
3. Confirm `SOLDCOMPS_API_KEY` + `HUGGINGFACE_TOKEN` exist in **edge-function** secrets (separate from GH Actions). Missing keys degrade safely (smart-link / empty), but the feature is only "the works" with them set.
4. Merge frontend → deploy. Members see the full report immediately.

## Validation checklist (end to end)

- [ ] Signed-out user: feature gated (modal CTA to sign in), no edge calls fire.
- [ ] Signed-in: photo → identification (with `searchQuery`) appears within a few seconds.
- [ ] eBay section shows real sold prices with working listing links; `over_cap`/`live_error` show the right copy + smart link.
- [ ] Local-history section shows past lots with working detail links + median.
- [ ] Estimate reflects eBay median (falls back to local).
- [ ] Anon cannot execute the `*_by_vector` RPCs (`has_function_privilege('anon', …) = false`).
- [ ] `npm run test:unit`, parity test, `npm run lint`, `npm run ratchets` all green.

## Increment 2 (out of scope here, tracked)

Add the HF **vision** leg to `resale-embed`: validate HF serves `nomic-embed-vision-v1.5` for image feature-extraction → fuse `normalize(normalize(text)+normalize(image))` **byte-identical to `embed_nomic`** (acceptance test) → pass the photo base64 to `resale-embed`. Runtime-degrade to text-only if the vision call times out.
