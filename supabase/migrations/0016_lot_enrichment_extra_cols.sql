-- Add columns to lot_enrichment that enable incremental enrichment without
-- committed NDJSON files (part of the Supabase-first migration):
--   input_hash       — SHA fingerprint of the inputs (schema + model + text +
--                      photo size) that produced the enrichment; a matching hash
--                      on the next scrape means the lot is unchanged and can skip
--                      the API call (same role as enrichmentInputHash in NDJSON).
--   product_type     — the noun (v3 schema: "office chair", "cast-iron pan", …)
--   search_query     — model-composed best eBay sold-listing phrase
--   brand_confidence — per-field confidence for brand ("low"/"medium"/"high")
--   model_confidence — per-field confidence for model/SKU

alter table lot_enrichment
  add column if not exists product_type     text,
  add column if not exists search_query     text,
  add column if not exists brand_confidence text,
  add column if not exists model_confidence text,
  add column if not exists input_hash       text;
