-- Cannon's historical sold prices → Supabase (issue #95 / M3.2).
--
-- The archive read model (public/data/archive/) records what every closed lot
-- sold for: `finalBid` is captured at close by rescrape_all.finalize_closed_file
-- (#94). This table mirrors those closed lots into Supabase so margin queries are
-- dynamic — the browser reads per-item history and per-category medians with the
-- publishable key to surface past sold prices (#96) and rank best-margin items
-- (#97). The scraper (scraper/sold_history.py) upserts with the secret key, which
-- bypasses RLS, keyed on (auction_safe_id, item_id).
--
-- Final price per lot: `finalBid` when present, else the last-seen `currentBid`
-- (lots archived before #94). Lots that closed with no bid (price 0) are not
-- "sold" and are excluded from the public views below.

create table if not exists sold_lots (
  auction_safe_id  text not null,
  item_id          text not null,
  auction_id       text,
  auction_title    text,
  lot_number       bigint,
  title            text,
  description      text,
  category         text,
  raw_category     text,
  final_bid        numeric(12, 2),
  total_bids       integer,
  unique_bidders   integer,
  sold_at          timestamptz,
  image_url        text,
  detail_url       text,
  source           text,
  updated_at       timestamptz not null default now(),
  primary key (auction_safe_id, item_id)
);

-- Category margin queries + recency scans.
create index if not exists sold_lots_category_sold_at
  on sold_lots (category, sold_at desc);

-- Public, read-only data (sold prices on a public auction site). RLS is enabled
-- so the publishable key can only SELECT; there is no insert/update/delete policy,
-- so writes require the secret key (which bypasses RLS). The browser reads the
-- views below, never the base table directly.
alter table sold_lots enable row level security;

drop policy if exists "public read sold lots" on sold_lots;
create policy "public read sold lots" on sold_lots
  for select using (true);

-- Per-item history the browser matches against (only lots that actually sold).
-- security_invoker = on so the base-table SELECT policy governs access.
create or replace view public_sold_lots
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
  image_url,
  detail_url,
  source
from sold_lots
where final_bid is not null and final_bid > 0;

-- Per-category margin signal: median realized price, range, count, and recency.
create or replace view public_category_sold_stats
  with (security_invoker = on) as
select
  category,
  count(*)                                                as sold_count,
  percentile_cont(0.5) within group (order by final_bid)  as median_sold,
  min(final_bid)                                          as min_sold,
  max(final_bid)                                          as max_sold,
  max(sold_at)                                            as last_sold_at
from sold_lots
where final_bid is not null and final_bid > 0
group by category;

grant select on public_sold_lots, public_category_sold_stats to anon, authenticated;
