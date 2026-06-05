-- LLM lot enrichment → Supabase (issue #104).
--
-- scraper/enrich.py asks Claude Haiku to read each lot (text + photo) and pull
-- out structured resale metadata: brand, model/SKU, condition, a canonical
-- product URL, and a confidence. Those fields persist to the NDJSON/Parquet read
-- model; this table mirrors the *identified* lots into Supabase so the metadata
-- is queryable via the API. The scraper (scraper/supabase_enrichment.py) upserts
-- with the secret key (bypasses RLS), keyed on (auction_safe_id, item_id). Only
-- lots that were actually identified (non-empty confidence) are written, so the
-- table is a clean index of identified products, not a row per lot.

create table if not exists lot_enrichment (
  auction_safe_id  text not null,
  item_id          text not null,
  auction_id       text,
  auction_title    text,
  lot_number       bigint,
  title            text,
  category         text,
  raw_category     text,
  brand            text,
  model_or_sku     text,
  condition        text,
  product_url      text,
  confidence       text,
  model            text,
  image_url        text,
  detail_url       text,
  source           text,
  updated_at       timestamptz not null default now(),
  primary key (auction_safe_id, item_id)
);

-- Browse identified products by confidence / brand.
create index if not exists lot_enrichment_confidence_brand
  on lot_enrichment (confidence, brand);

-- Public, read-only metadata (derived from a public auction site). RLS is enabled
-- so the publishable key can only SELECT; with no insert/update/delete policy,
-- writes require the secret key (which bypasses RLS). The browser/API reads the
-- view below, never the base table directly.
alter table lot_enrichment enable row level security;

drop policy if exists "public read lot enrichment" on lot_enrichment;
create policy "public read lot enrichment" on lot_enrichment
  for select using (true);

-- security_invoker = on so the base-table SELECT policy governs access.
create or replace view public_lot_enrichment
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  auction_id,
  auction_title,
  lot_number,
  title,
  category,
  raw_category,
  brand,
  model_or_sku,
  condition,
  product_url,
  confidence,
  model,
  image_url,
  detail_url,
  source,
  updated_at
from lot_enrichment;

grant select on public_lot_enrichment to anon, authenticated;
