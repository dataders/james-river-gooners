-- eBay comps → Supabase (issue #6).
--
-- Migrates eBay sold-comp storage off the static `public/data/ebay-comps/*.json`
-- read model. The scraper appends one row per (item, matched eBay listing) to
-- `ebay_comp_snapshots` using the secret key (which bypasses RLS); the browser
-- reads the deduplicated `public_auction_comps` view with the publishable key.
--
-- Columns mirror the MotherDuck `ebay_comp_snapshots` table the scraper already
-- writes (scraper/ebay_comps.py), so the same row dicts serialize to either
-- backend. `id`/`ingested_at` are Postgres-filled; the scraper never sends them.

create table if not exists ebay_comp_snapshots (
  id                  bigint generated always as identity primary key,
  auction_safe_id     text,
  item_id             text,
  status              text,
  query               text,
  search_url          text,
  fetched_at          timestamptz,
  warning             text,
  ebay_item_id        text,
  title               text,
  price_value         numeric(12, 2),
  price_currency      text,
  shipping_label      text,
  sold_date           date,
  sold_date_label     text,
  thumbnail_url       text,
  item_web_url        text,
  condition           text,
  source_query        text,
  match_confidence    text,
  auction_id          text,
  lot_number          bigint,
  cannons_title       text,
  cannons_description text,
  current_bid         numeric(12, 2),
  total_bids          integer,
  detail_url          text,
  raw_match_json      text,
  ingested_at         timestamptz not null default now()
);

-- The dedup view ranks by fetched_at within (auction, item, source_query); this
-- index makes that window cheap and also serves the browser's per-auction reads.
create index if not exists ebay_comp_snapshots_lookup
  on ebay_comp_snapshots (auction_safe_id, item_id, source_query, fetched_at desc);

-- Public, read-only data (eBay sold listings already public). RLS is enabled so
-- the publishable key can only ever SELECT — there is no insert/update/delete
-- policy, so writes require the secret key (which bypasses RLS entirely).
alter table ebay_comp_snapshots enable row level security;

drop policy if exists "public read comps" on ebay_comp_snapshots;
create policy "public read comps" on ebay_comp_snapshots
  for select using (true);

-- Deduplicated read model: latest fetch per (auction, item, source_query),
-- dropping rows that found no eBay listing. `security_invoker = on` so the
-- base-table SELECT policy above governs access (avoids a security-definer
-- view); the browser only ever needs these public columns.
create or replace view public_auction_comps
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  status,
  query,
  search_url,
  fetched_at,
  warning,
  ebay_item_id,
  title,
  price_value,
  price_currency,
  shipping_label,
  sold_date,
  sold_date_label,
  thumbnail_url,
  item_web_url,
  condition,
  source_query,
  match_confidence
from (
  select
    *,
    dense_rank() over (
      partition by auction_safe_id, item_id, source_query
      order by fetched_at desc
    ) as fetch_rank
  from ebay_comp_snapshots
  where item_web_url is not null
) ranked
where fetch_rank = 1;

grant select on public_auction_comps to anon, authenticated;
