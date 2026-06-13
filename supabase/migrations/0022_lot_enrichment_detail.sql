-- v6 category-aware detail fields (PR: enrich v6 — category detail keys).
-- Unbranded lots whose resale identity is descriptive rather than brand+model
-- (antique furniture, signed paintings, decorative ceramics) now carry a
-- category-keyed detail bag, so they clear the medium/high display+comp bar.
-- Extends lot_enrichment with:
--   detail_category   — furniture | art | ceramics_glass | other (the lot's kind)
--   details           — JSON object of the resale-identifying keys for that
--                       category (furniture: style/material/form; art: artist/
--                       medium/subject; ceramics_glass: maker/pattern/material),
--                       pruned to the chosen category with empties dropped, "" when
--                       not applicable
--   detail_confidence — low/medium/high, scored independently; folds into the
--                       overall `confidence` (= max of brand/model/detail)
-- Stored as text (JSON for the object), mirroring how the read model keeps the
-- other detail columns so the browser parses client-side.

alter table lot_enrichment
  add column if not exists detail_category   text,
  add column if not exists details           text,
  add column if not exists detail_confidence text;

-- Recreate the public view to expose the v6 columns. The new columns slot in
-- next to the other detail fields (before `notes`), which `create or replace`
-- can't do — it only appends, never reorders existing view columns — so drop
-- and recreate. security_invoker runs the view with the querying role's
-- privileges. NOTE: unlike the members-only comps/sold tables (gated by 0008),
-- lot_enrichment is intentionally PUBLIC-read — 0009 gave it a `using (true)`
-- SELECT policy because the brand/model/detail labels are a public browsing
-- aid (the ✨ Identified grid works logged-out). Anon reads these rows by design.
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
  image_url,
  detail_url,
  source,
  updated_at
from lot_enrichment;

grant select on public_lot_enrichment to anon, authenticated;
