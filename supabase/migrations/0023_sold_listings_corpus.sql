-- Raw eBay sold-listings corpus (SoldComps Phase 2 / RFC #290, increment 1).
--
-- Phase 1 (#283) requests up to count=40 sold listings per SoldComps API call
-- but the curated `ebay_comp_snapshots` keeps only the top ~3 per query. This
-- table persists the FULL candidate set — deduped by eBay listing id — so the
-- listings we already pay for become a reusable corpus for the Nomic visual
-- re-rank (increment 2) and corpus-first reuse (increment 3).
--
-- A sold listing is immutable (its price/date never change once sold), so the
-- write is "insert, or on conflict keep first values + bump last_seen_at": the
-- scraper upserts with `resolution=merge-duplicates`; seen_count stays a coarse
-- last-writer value (exact counting is a nice-to-have, not load-bearing). Writes
-- use the secret key (service_role, bypasses RLS).
--
-- Retention (RFC #290, D5): NONE. We retain every listing and instead query the
-- corpus within a recency window, widening to older listings only when a lot
-- finds nothing — so sparse categories still get comps without keeping stale
-- ones by default. (raw_json is the only heavy column; drop it if size bites.)

create table if not exists sold_listings (
  ebay_item_id    text primary key,          -- dedup key: one row per sold listing
  title           text,
  sold_price      numeric,
  sold_currency   text,
  sold_date       date,
  sold_date_label text,
  category_id     text,                       -- the eBay categoryId we queried under
  condition       text,
  thumbnail_url   text,
  item_web_url    text,
  source_query    text,                       -- query that surfaced it (debug)
  seen_count      int  not null default 1,    -- coarse # of lot-queries that hit it
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  raw_json        jsonb                       -- full provider item; future-proofing
);

create index if not exists sold_listings_category_id on sold_listings (category_id);
create index if not exists sold_listings_sold_date on sold_listings (sold_date);

-- RLS on with NO select policy: scraper-internal in increment 1 (nothing in the
-- browser reads it). Only the secret key (service_role) bypasses RLS. A public
-- view can be added later if the UI ever surfaces "N comparable sold listings".
alter table sold_listings enable row level security;
