-- Cannon's comps → Supabase, gated behind auth (#132 part 3 / #150).
--
-- Replaces the static public/data/cannons-comps/*.json read model with a
-- Supabase table, mirroring ebay_comp_snapshots. "Cannon's comps" are the most
-- similar *past* (archived) lots and what they sold for, precomputed by the
-- scraper (scraper/cannons_comps.py, CLIP similarity vs the archive corpus).
--
-- The browser reads the public_cannons_comps view with the publishable key.
-- Like the other resale-intelligence views (migration 0008), SELECT is
-- restricted to authenticated sessions, so a logged-out browser reads zero rows
-- — this finally enforces the gating that #149 could only fake at the UI level
-- (the static JSON was still directly fetchable). The scraper writes with the
-- secret key (service_role), which bypasses RLS.

create table if not exists cannons_comp_snapshots (
  id               bigint generated always as identity primary key,
  auction_safe_id  text not null,
  item_id          text not null,
  rank             integer not null default 0,   -- 0-based, best (most similar) first
  match_title      text,
  sold_price       numeric(12, 2),
  sold_date        text,                          -- ISO or Maxanet shape, stored as-is
  thumbnail_url    text,
  detail_url       text,
  auction_title    text,
  source           text,
  similarity       numeric(6, 4),
  generated_at     timestamptz not null,          -- one value per scraper run
  ingested_at      timestamptz not null default now()
);

-- The browser's per-auction read and the writer's per-auction prune both filter
-- on auction_safe_id; generated_at desc selects the latest generation.
create index if not exists cannons_comp_snapshots_lookup
  on cannons_comp_snapshots (auction_safe_id, generated_at desc);

-- Members-only: SELECT requires an authenticated session (mirrors 0008). There
-- is no insert/update/delete policy, so writes require the secret key (which
-- bypasses RLS). The browser reads the view below, never the base table.
alter table cannons_comp_snapshots enable row level security;
drop policy if exists "authenticated read cannons comps" on cannons_comp_snapshots;
create policy "authenticated read cannons comps" on cannons_comp_snapshots
  for select using ((select auth.uid()) is not null);

-- Latest generation per (auction, item): the writer appends a new generation
-- each run and prunes older ones, but the dedup keeps the view correct even mid
-- prune. security_invoker = on so the base-table policy governs access — anon
-- gets zero rows.
create or replace view public_cannons_comps
  with (security_invoker = on) as
select
  auction_safe_id,
  item_id,
  rank,
  match_title,
  sold_price,
  sold_date,
  thumbnail_url,
  detail_url,
  auction_title,
  source,
  similarity
from (
  select
    *,
    dense_rank() over (
      partition by auction_safe_id, item_id
      order by generated_at desc
    ) as gen_rank
  from cannons_comp_snapshots
) ranked
where gen_rank = 1;

grant select on public_cannons_comps to anon, authenticated;
