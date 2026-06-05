-- eBay comps: Supabase becomes the ledger, retiring the static JSON read model
-- as the scraper's state store (issue #6, phase 2).
--
-- The per-auction `public/data/ebay-comps/*.json` files were doing double duty:
-- the browser read model AND the scraper's own bookkeeping -- which items were
-- fetched recently (freshness skip) and how many eBay requests were spent this
-- month (the shared request budget). Now that comps live in
-- `ebay_comp_snapshots`, both can be reconstructed from it, so the scraper no
-- longer needs the JSON to pace itself. These two views expose exactly the two
-- facts the file ledger held; `scraper/supabase_comps.py` reads them.

-- One row per distinct eBay request that actually ran. A successful query writes
-- N match rows that share (auction, item, source_query, fetched_at); a fruitless
-- query writes a single placeholder row with that same tuple. So the distinct
-- tuples are the requests spent -- the meter the budget used to sum from the
-- JSON `attempts[item].queries`. (`fetched_at` is one value per run, and an
-- item's queries carry distinct `source_query` kinds, so tuples don't collide.)
create or replace view comp_query_attempts
  with (security_invoker = on) as
select distinct
  auction_safe_id,
  item_id,
  source_query,
  fetched_at
from ebay_comp_snapshots;

-- Latest fetch per (auction, item), whether or not it matched -- the freshness
-- ledger the scraper read from the JSON `attempts`/`items` maps to decide which
-- items to skip until they go stale.
create or replace view comp_item_freshness
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  max(fetched_at) as last_fetched_at
from ebay_comp_snapshots
group by auction_safe_id, item_id;

-- The scraper reads these with the secret key (service_role, which bypasses
-- RLS); grant explicitly so the views are selectable. They expose only
-- aggregate fetch bookkeeping -- no data the public view doesn't already show.
grant select on comp_query_attempts to service_role;
grant select on comp_item_freshness to service_role;
