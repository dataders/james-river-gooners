-- Consolidate sold_lots into lots, and wire up the lots ↔ satellite foreign keys.
--
-- Background (verified against the live db, 2026-06-14):
--   * sold_lots holds 21,382 rows that are EXACTLY `lots WHERE archived AND
--     final_bid > 0` — zero rows live outside lots. It is a denormalized copy
--     kept in sync by a separate nightly job (scraper/sold_history.py).
--   * The only datum sold_lots carries that lots does not is `sold_at` — a
--     timezone-parsed (America/New_York → UTC) close time. For 1,441 of those
--     rows the source date text has since been blanked in lots, so sold_at can
--     NOT be reconstructed from lots and must be PRESERVED, not recomputed.
--   * All satellite tables key on (auction_safe_id, item_id) but carried no FK
--     to lots. Orphan check: lot_enrichment 0, nomic_embeddings 0,
--     cannons_comp_snapshots 0, eval_embeddings 0, ebay_comp_snapshots 1.
--     The original "an item may be in sold_lots but not lots" blocker is gone
--     (lots already holds every archived item), so the FKs are now addable.
--
-- This migration:
--   1. Promotes sold_at to a real column on lots and backfills it losslessly.
--   2. Cleans the 1 orphan and adds the lots ↔ satellite FKs (ON DELETE CASCADE)
--      so the ERD draws lots as the hub and pruning a lot cascades its derived
--      rows. Also adds the eBay-side sold_listing_embeddings → sold_listings FK.
--   3. Replaces the sold_lots BASE TABLE with a column-compatible VIEW over lots
--      (drop-in for the match_cannons_comps RPC, the dbt `sold_lots` source, and
--      the public_* views) and re-homes the members-only gate from the dropped
--      table's RLS policy into the public_* view predicates.
--
-- Gating is UNCHANGED for the browser: a logged-out (anon) read of
-- public_sold_lots / public_category_sold_stats still returns zero rows. The
-- gate moves from base-table RLS (migration 0008) to an `auth.uid() is not null`
-- predicate in the views, because those views now read the public `lots` table.
--
-- ⚠️ REQUIRED COMPANION CHANGE (not DB): scraper/sold_history.py upserts into
-- sold_lots via PostgREST `resolution=merge-duplicates` (INSERT … ON CONFLICT),
-- which Postgres rejects against a view. After this migration that nightly job
-- (.github/workflows/sold-history.yml) MUST be disabled — it is now redundant
-- (lots is the source of truth). Until the live scrape writes lots.sold_at
-- itself, newly-archived lots will have sold_at = NULL (existing data is exact).
--
-- Rollback: recreate sold_lots as a table from `select * from sold_lots` (the
-- view), restore its RLS policy (0008), drop the FKs and lots.sold_at.

begin;

-- 1. Promote sold_at onto lots and backfill losslessly from the current table --
alter table lots add column if not exists sold_at timestamptz;

update lots l
   set sold_at = s.sold_at
  from sold_lots s
 where l.auction_safe_id = s.auction_safe_id
   and l.item_id = s.item_id
   and s.sold_at is not null;

-- 2. Integrity: clean the single orphan, then add the FKs ---------------------
-- Remove eBay comp snapshots that point at a (non-null) lot key not in lots.
-- Rows with a NULL key are left alone (a MATCH SIMPLE FK does not check them).
delete from ebay_comp_snapshots c
 where c.auction_safe_id is not null
   and c.item_id is not null
   and not exists (
     select 1 from lots l
      where l.auction_safe_id = c.auction_safe_id
        and l.item_id = c.item_id
   );

-- 1:1 satellites
alter table lot_enrichment
  add constraint lot_enrichment_lot_fkey
  foreign key (auction_safe_id, item_id) references lots (auction_safe_id, item_id)
  on delete cascade;

alter table nomic_embeddings
  add constraint nomic_embeddings_lot_fkey
  foreign key (auction_safe_id, item_id) references lots (auction_safe_id, item_id)
  on delete cascade;

alter table eval_embeddings
  add constraint eval_embeddings_lot_fkey
  foreign key (auction_safe_id, item_id) references lots (auction_safe_id, item_id)
  on delete cascade;

-- 1:many satellites
alter table ebay_comp_snapshots
  add constraint ebay_comp_snapshots_lot_fkey
  foreign key (auction_safe_id, item_id) references lots (auction_safe_id, item_id)
  on delete cascade;

alter table cannons_comp_snapshots
  add constraint cannons_comp_snapshots_lot_fkey
  foreign key (auction_safe_id, item_id) references lots (auction_safe_id, item_id)
  on delete cascade;

-- eBay-side corpus: embeddings belong to a sold_listing row
alter table sold_listing_embeddings
  add constraint sold_listing_embeddings_listing_fkey
  foreign key (ebay_item_id) references sold_listings (ebay_item_id)
  on delete cascade;

-- 3. Replace the sold_lots base table with a view over lots ------------------
-- Drop the objects that depend on the base table first. match_cannons_comps is
-- a SQL-language function with a hard dependency on sold_lots, so it must be
-- dropped and recreated rather than relying on DROP … CASCADE.
drop view if exists public_sold_lots;
drop view if exists public_category_sold_stats;
drop function if exists match_cannons_comps(text, int, float);

drop table if exists sold_lots;

-- Column-compatible view: same shape the table had, projected from lots. This
-- keeps the dbt `sold_lots` source and the recreated RPC working unchanged.
create view sold_lots
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  auction_id,
  auction_title,
  lot_number,
  title,
  description,
  category,
  raw_category,
  final_bid,
  total_bids,
  unique_bidders,
  sold_at,
  images[1]  as image_url,
  detail_url,
  source,
  updated_at
from lots
where archived and final_bid is not null and final_bid > 0;

-- Internal compat layer (RPC + dbt). Not the browser's entry point, so it is not
-- granted to anon; the members-only gate lives in the public_* views below.
grant select on sold_lots to authenticated, service_role;

-- Supports the per-category recency/median aggregation below.
create index if not exists lots_sold_category
  on lots (category, sold_at desc)
  where archived and final_bid is not null and final_bid > 0;

-- Recreate the RPC verbatim (now bound to the sold_lots view). SECURITY DEFINER,
-- so it reads across the public lots view as the owner regardless of caller.
create or replace function match_cannons_comps(
  active_auction text,
  match_count int default 3,
  min_sim float default 0.80
)
returns table (
  item_id text,
  comp_auction_safe_id text,
  comp_item_id text,
  similarity float,
  title text,
  sold_price numeric,
  sold_at timestamptz,
  image_url text,
  detail_url text,
  auction_title text,
  source text
)
language sql stable security definer
set search_path = public
set statement_timeout to '180s'
as $$
  select
    a.item_id,
    c.auction_safe_id,
    c.item_id,
    c.sim,
    c.title,
    c.final_bid,
    c.sold_at,
    c.image_url,
    c.detail_url,
    c.auction_title,
    c.source
  from nomic_embeddings a
  cross join lateral (
    select
      s.auction_safe_id, s.item_id, s.title, s.final_bid, s.sold_at,
      s.image_url, s.detail_url, s.auction_title, s.source,
      1 - (n.embedding <=> a.embedding) as sim
    from nomic_embeddings n
    join sold_lots s
      on s.auction_safe_id = n.auction_safe_id and s.item_id = n.item_id
    where n.auction_safe_id <> a.auction_safe_id
      and s.final_bid is not null and s.final_bid > 0
    order by n.embedding <=> a.embedding
    limit greatest(1, least(match_count, 20))
  ) c
  where a.auction_safe_id = active_auction
    and c.sim >= min_sim
  order by a.item_id, c.sim desc;
$$;

grant execute on function match_cannons_comps(text, int, float) to authenticated, service_role;

-- Public views: read from lots, gated members-only by an auth predicate so an
-- anon caller still gets zero rows (replaces the dropped table's 0008 RLS gate).
create view public_sold_lots
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  auction_title,
  lot_number,
  title,
  description,
  category,
  raw_category,
  final_bid,
  total_bids,
  unique_bidders,
  sold_at,
  images[1] as image_url,
  detail_url,
  source
from lots
where archived and final_bid is not null and final_bid > 0
  and (select auth.uid()) is not null;

create view public_category_sold_stats
  with (security_invoker = on) as
select
  category,
  count(*)                                                as sold_count,
  percentile_cont(0.5) within group (order by final_bid)  as median_sold,
  min(final_bid)                                          as min_sold,
  max(final_bid)                                          as max_sold,
  max(sold_at)                                            as last_sold_at
from lots
where archived and final_bid is not null and final_bid > 0
  and (select auth.uid()) is not null
group by category;

grant select on public_sold_lots, public_category_sold_stats to anon, authenticated;

commit;
