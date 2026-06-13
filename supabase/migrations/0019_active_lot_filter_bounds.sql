-- Global filter bounds for the price/bidding range sliders.
--
-- The sliders' max (a 99th-percentile cap, to keep one outlier from compressing
-- everyone into a sliver) was derived client-side from whatever lots had streamed
-- in so far. The first page is a storage-ordered slice (one or two auctions), not
-- a random sample, so during the multi-second progressive load the bounds were
-- biased low and visibly jumped. Bounds are a global property of the dataset, so
-- compute them once on the server: a sub-second aggregate over the same
-- anon-readable card view the grid reads, fetched up front for stable, correct
-- track bounds from first paint. No materialized view needed.
--
-- security_invoker so it runs as the caller against the RLS-public view (the
-- browser already reads public_active_lots_card with the publishable key).
create or replace function get_active_lot_filter_bounds()
returns table (price_p99 numeric, bids_p99 numeric, bidders_p99 numeric)
language sql stable security invoker set search_path = public as $$
  select
    coalesce(percentile_cont(0.99) within group (order by current_bid), 0)::numeric,
    coalesce(percentile_cont(0.99) within group (order by total_bids), 0)::numeric,
    coalesce(percentile_cont(0.99) within group (order by coalesce(unique_bidders, 0)), 0)::numeric
  from public_active_lots_card;
$$;

grant execute on function get_active_lot_filter_bounds() to anon, authenticated;
