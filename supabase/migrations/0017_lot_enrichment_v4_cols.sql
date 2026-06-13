-- v4 enrichment fields — lot economics + resale risk, and multi-brand lots
-- (PR: enrich v4 + Option B). Extends lot_enrichment with:
--   quantity        — item count as a digit string ("" when indeterminate)
--   is_mixed_lot    — "true"/"false": a box of *different* items vs many identical
--   condition_flags — JSON array of resale-risk flags (untested/damaged/…), "" empty
--   key_attributes  — JSON array of search-identifying specs (size/material/…), "" empty
--   secondary_items — JSON array of the other identifiable products in a multi-brand
--                     lot ({brand, model_or_sku, product_type, search_query} each)
-- Stored as text (JSON-encoded for the arrays), mirroring how the read model keeps
-- them so the browser parses client-side — consistent with the existing text columns.

alter table lot_enrichment
  add column if not exists quantity        text,
  add column if not exists is_mixed_lot    text,
  add column if not exists condition_flags text,
  add column if not exists key_attributes  text,
  add column if not exists secondary_items text;

-- Recreate the public view to expose the v4 columns AND the v3 columns that
-- 0016 added to the table but were never surfaced (product_type, search_query,
-- brand_confidence, model_confidence). Additive; security_invoker keeps the
-- 0008 auth gate (SELECT on lot_enrichment requires an authenticated session).
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
  confidence,
  model,
  image_url,
  detail_url,
  source,
  updated_at
from lot_enrichment;

grant select on public_lot_enrichment to anon, authenticated;
