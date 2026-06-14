-- Lot-enrichment lineage: queryable schema version + a real updated_at.
--
-- Two gaps made it impossible to reason about enrichment freshness/provenance
-- from the table alone:
--   1. The enrichment schema version (enrich.py ENRICHMENT_SCHEMA_VERSION) was
--      folded only into `input_hash`, never stored as its own value — so you
--      could not answer "which lots are still on v5?" without recomputing hashes.
--   2. `updated_at` was `default now()`, which fires on INSERT only. The scraper
--      upserts with `resolution=merge-duplicates` (ON CONFLICT DO UPDATE), so a
--      re-enrich UPDATED the row in place without bumping `updated_at` — the
--      column tracked *insert* time, not last-enrichment time, and looked stale
--      even right after a fresh backfill.
--
-- This adds the `schema_version` column (stamped by supabase_enrichment.py from
-- the lot's `enrichmentSchemaVersion`) and a BEFORE UPDATE trigger so every
-- update bumps `updated_at`. Additive + backward-compatible: the column is
-- nullable, old code that omits it still works, and the browser ignores columns
-- it doesn't read.

alter table lot_enrichment
  add column if not exists schema_version text;

-- Bump updated_at on every UPDATE (Postgres defaults only fire on INSERT).
-- Dedicated function name so we don't collide with any other table's trigger.
create or replace function lot_enrichment_touch_updated_at()
returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists lot_enrichment_set_updated_at on lot_enrichment;
create trigger lot_enrichment_set_updated_at
  before update on lot_enrichment
  for each row execute function lot_enrichment_touch_updated_at();

-- Recreate the public view to expose `schema_version` (slots next to `model`,
-- which `create or replace` can't do mid-list — it only appends). Mirrors the
-- 0022 view otherwise; lot_enrichment is intentionally PUBLIC-read (0009's
-- `using (true)` SELECT policy) because the brand/model/detail labels are a
-- public browsing aid.
drop view if exists public_lot_enrichment;
create view public_lot_enrichment
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
  product_type,
  search_query,
  condition,
  product_url,
  brand_confidence,
  model_confidence,
  quantity,
  is_mixed_lot,
  condition_flags,
  key_attributes,
  secondary_items,
  detail_category,
  details,
  detail_confidence,
  notes,
  confidence,
  model,
  schema_version,
  image_url,
  detail_url,
  source,
  updated_at
from lot_enrichment;

grant select on public_lot_enrichment to anon, authenticated;
