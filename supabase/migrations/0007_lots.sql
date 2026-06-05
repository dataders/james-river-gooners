-- Active + archived lot listings → Supabase (issue #98).
--
-- Migrates the live auction browsing read model off the static NDJSON sidecars
-- (public/data/items/*.ndjson) into Postgres so the browser queries PostgREST
-- on tab open instead of 21 parallel file fetches. The "load everything once,
-- filter client-side" pattern is preserved: ~7-8K active items fit in one
-- paginated SELECT (~2K rows/page), so filter/sort/search latency stays
-- sub-millisecond in the browser, identical to today.
--
-- The scraper upserts with the secret key (bypasses RLS); the browser reads
-- public_active_lots / public_archived_lots with the publishable key.

create table if not exists lots (
  auction_safe_id  text not null,
  item_id          text not null,
  lot_number       bigint,
  title            text,
  description      text,
  current_bid      numeric(12,2),
  total_bids       integer,
  unique_bidders   integer,
  end_date         text,
  images           text[],
  category         text,
  raw_category     text,
  detail_url       text,
  auction_id       text,
  auction_title    text,
  auction_end_date text,
  scraped_at       timestamptz,
  source           text,
  archived         boolean not null default false,
  final_bid        numeric(12,2),
  closed           boolean,
  updated_at       timestamptz not null default now(),
  primary key (auction_safe_id, item_id)
);

-- Efficient reads for the two views the browser uses.
create index if not exists lots_active_auction
  on lots (auction_safe_id) where not archived;

create index if not exists lots_archived_auction
  on lots (auction_safe_id) where archived;

alter table lots enable row level security;

drop policy if exists "public read lots" on lots;
create policy "public read lots" on lots
  for select using (true);

-- Active lots view — main browsing grid. Excludes archived/final-price columns
-- so the per-row payload stays tight.
create or replace view public_active_lots
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images, category, raw_category,
  detail_url, auction_id, auction_title, auction_end_date, scraped_at, source
from lots
where not archived;

-- Archived lots view — loaded only when the user enables the archive toggle.
create or replace view public_archived_lots
  with (security_invoker = on) as
select
  auction_safe_id, item_id, lot_number, title, description, current_bid,
  total_bids, unique_bidders, end_date, images, category, raw_category,
  detail_url, auction_id, auction_title, auction_end_date, scraped_at, source,
  final_bid, closed
from lots
where archived;

grant select on public_active_lots, public_archived_lots to anon, authenticated;
