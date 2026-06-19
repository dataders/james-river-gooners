-- Normalize raw_json fields in sold_listings into typed columns (issue #298 follow-up).
--
-- The SoldComps API returns more than what migration 0023 normalized. These columns
-- are populated at insert time (supabase_sold_listings.py) going forward, and the
-- backfill script derives them from raw_json for existing rows.
--
-- Key fields for embedding quality:
--   epid                   — eBay product catalog ID (parallels brand+model identity)
--   full_res_thumbnail_url — higher-res image for visual embedding
--   condition_id           — numeric eBay condition code (1000=New, 3000=Used, etc.)
--
-- Seller fields are kept for potential future filtering (e.g. exclude poor-feedback sellers).
-- raw_json stays untouched as the full provider record.

alter table sold_listings
  add column if not exists epid                   text,
  add column if not exists condition_id           text,
  add column if not exists shipping_price         numeric,
  add column if not exists shipping_currency      text,
  add column if not exists shipping_type          text,
  add column if not exists total_price            numeric,
  add column if not exists seller_type            text,
  add column if not exists seller_username        text,
  add column if not exists seller_feedback_score  int,
  add column if not exists seller_positive_pct    numeric,
  add column if not exists full_res_thumbnail_url text,
  add column if not exists provider_scraped_at    timestamptz;

-- Backfill all existing rows from raw_json in one pass.
update sold_listings
set
  epid                   = raw_json->>'epid',
  condition_id           = raw_json->>'conditionId',
  shipping_price         = (raw_json->>'shippingPrice')::numeric,
  shipping_currency      = raw_json->>'shippingCurrency',
  shipping_type          = raw_json->>'shippingType',
  total_price            = (raw_json->>'totalPrice')::numeric,
  seller_type            = raw_json->>'sellerType',
  seller_username        = raw_json->>'sellerUsername',
  seller_feedback_score  = (raw_json->>'sellerFeedbackScore')::int,
  seller_positive_pct    = (raw_json->>'sellerPositivePercent')::numeric,
  full_res_thumbnail_url = raw_json->>'fullResThumbnailUrl',
  provider_scraped_at    = (raw_json->>'scrapedAt')::timestamptz
where raw_json is not null;

-- Index on epid for corpus-first reuse lookups by product identity.
create index if not exists sold_listings_epid on sold_listings (epid) where epid is not null;
