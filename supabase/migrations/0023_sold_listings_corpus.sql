-- Raw eBay sold-listings corpus (SoldComps Phase 2, issue #293, part 1).
--
-- Phase 1 (#283) requests up to `count` (40) sold listings per SoldComps API
-- call but the curated `ebay_comp_snapshots` table keeps only the top ~3 per
-- query. This table persists the *full* candidate set per call — deduped by
-- eBay item id — so the listings we already pay for become a reusable corpus:
--   * Phase 2 part 2: a batch job embeds each listing's thumbnail with the #165
--     Nomic vision model and re-ranks a lot's candidates by visual similarity
--     against the lot's own `nomic_embeddings` vector ("right words, wrong
--     object" filtering).
--   * Phase 2 part 3: corpus-first reuse — check here for fresh, same-category
--     listings before spending another API request.
--
-- One row per distinct eBay listing (primary key `ebay_item_id`); the scraper
-- upserts (merge-duplicates), refreshing the listing's attributes + last_seen_at
-- on re-encounter while preserving first_seen_at. Writes use the secret key
-- (service_role, bypasses RLS).

create table if not exists sold_listings (
  ebay_item_id    text primary key,
  title           text,
  price_value     numeric(12, 2),
  price_currency  text,
  shipping_label  text,
  sold_date       date,
  sold_date_label text,
  thumbnail_url   text,
  item_web_url    text,
  condition       text,
  -- Provenance: the search context that surfaced this listing (the lot's
  -- category + the query that found it) — drives same-category corpus reuse.
  source_query    text,
  query           text,
  category        text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

-- Serves the corpus-first reuse lookup (fresh listings within a category).
create index if not exists sold_listings_category_recency
  on sold_listings (category, sold_date desc);

-- RLS on with NO select policy: this is scraper-side infrastructure, not yet a
-- browser read model. The secret key (service_role) bypasses RLS for the
-- writer; anon/authenticated get zero rows until a deliberate public view is
-- added (mirrors the members-only posture of the resale-intelligence tables).
alter table sold_listings enable row level security;
