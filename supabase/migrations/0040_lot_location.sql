-- Auction location → coordinates, for the browser's distance filter (zip-code /
-- "use my location" radius filter that replaces the binary "Richmond area only"
-- toggle). The scraper geocodes each auction's city/state to lat/lng at scrape
-- time (scraper/geocode.py) and stamps it onto every lot; a lot that can't be
-- geocoded fails the scrape, so these columns are effectively always populated
-- going forward. Existing rows are backfilled before the new frontend ships
-- (see "Rolling out data-backed migrations" in CLAUDE.md).
--
-- Additive on purpose: the columns are nullable and the views are recreated to
-- add them, so the deployed frontend keeps working until the new one ships.

alter table lots
  add column if not exists auction_city      text,
  add column if not exists auction_state     text,
  add column if not exists auction_latitude  numeric(9,6),
  add column if not exists auction_longitude numeric(9,6);

-- Recreate the four read views with the new columns. CREATE OR REPLACE VIEW
-- can't drop/reorder existing columns, but appending is fine.

create or replace view public_active_lots
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images, category, raw_category,
  detail_url, auction_id, auction_title, auction_end_date, scraped_at, source,
  auction_city, auction_state, auction_latitude, auction_longitude
from lots
where not archived;

create or replace view public_archived_lots
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images, category, raw_category,
  detail_url, auction_id, auction_title, auction_end_date, scraped_at, source,
  final_bid, closed,
  auction_city, auction_state, auction_latitude, auction_longitude
from lots
where archived;

-- The _card views the grid actually reads (images sliced to the thumbnail).
-- Coordinates are tiny, so they ride along in the bulk grid payload.
create or replace view public_active_lots_card
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images[1:1] as images, category,
  raw_category, detail_url, auction_id, auction_title, auction_end_date,
  scraped_at, source,
  auction_city, auction_state, auction_latitude, auction_longitude
from lots
where not archived;

create or replace view public_archived_lots_card
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images[1:1] as images, category,
  raw_category, detail_url, auction_id, auction_title, auction_end_date,
  scraped_at, source, final_bid, closed,
  auction_city, auction_state, auction_latitude, auction_longitude
from lots
where archived;

grant select on public_active_lots, public_archived_lots to anon, authenticated;
grant select on public_active_lots_card, public_archived_lots_card to anon, authenticated;
