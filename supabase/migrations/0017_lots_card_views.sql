-- Thumbnail-only "card" views for the main browsing grid (faster initial load).
--
-- public_active_lots / public_archived_lots ship the FULL images[] array per
-- lot (~3.2 images each) — that array is ~2.9 MB of the ~7.4 MB active payload,
-- almost all of it image URLs the grid never renders (an ItemCard shows
-- images[0] only). These _card views slice images down to the first element so
-- the bulk grid load transfers a fraction of the bytes and the server scan
-- detoasts far less; the detail panel hydrates the full image set on demand
-- from the full views above (a single primary-key lookup per lot opened).
--
-- Additive on purpose: the full views are left untouched, so the deployed
-- frontend keeps working until the new one ships (see "Rolling out data-backed
-- migrations" in CLAUDE.md). security_invoker + grants mirror 0007_lots.sql.

create or replace view public_active_lots_card
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images[1:1] as images, category,
  raw_category, detail_url, auction_id, auction_title, auction_end_date,
  scraped_at, source
from lots
where not archived;

create or replace view public_archived_lots_card
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images[1:1] as images, category,
  raw_category, detail_url, auction_id, auction_title, auction_end_date,
  scraped_at, source, final_bid, closed
from lots
where archived;

grant select on public_active_lots_card, public_archived_lots_card to anon, authenticated;
