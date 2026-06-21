-- 0038_resale_report_rpcs.sql
-- Photo resale report (spec 2026-06-20): arbitrary-vector comp matching for a
-- user-supplied photo (no source auction lot), plus a per-user daily scan cap.

-- eBay sold-listings corpus, matched by an arbitrary 768-dim query vector.
-- Mirror of match_sold_listings (0027) without the (auction,item) source lookup.
create or replace function match_sold_listings_by_vector(
  query_embedding vector(768),
  match_count int default 8,
  min_sim float default 0.75
)
returns table (
  ebay_item_id text,
  similarity float,
  title text,
  sold_price numeric,
  sold_date date,
  sold_date_label text,
  condition text,
  thumbnail_url text,
  item_web_url text
)
language sql stable security definer
set search_path = public
set statement_timeout to '30s'
as $$
  select
    sl.ebay_item_id,
    1 - (e.embedding <=> query_embedding) as similarity,
    sl.title, sl.sold_price, sl.sold_date, sl.sold_date_label,
    sl.condition, sl.thumbnail_url, sl.item_web_url
  from sold_listing_embeddings e
  join sold_listings sl on sl.ebay_item_id = e.ebay_item_id
  where 1 - (e.embedding <=> query_embedding) >= min_sim
  order by e.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

-- Supabase's ALTER DEFAULT PRIVILEGES auto-grants EXECUTE on every new public
-- function to anon, authenticated, service_role. These SECURITY DEFINER functions
-- return members-only sold prices, so revoke the anon grant explicitly (revoking
-- from PUBLIC alone is insufficient — anon holds its own direct grant) before
-- re-granting only the intended roles.
revoke execute on function match_sold_listings_by_vector(vector, int, float)
  from public, anon;
grant execute on function match_sold_listings_by_vector(vector, int, float)
  to authenticated, service_role;

-- Local sold history (Cannon's/HiBid/Rasmus), matched by an arbitrary vector.
-- Mirror of match_cannons_comps (0014) without the own-auction exclusion (there
-- is no source lot). sold_lots is already archive-only + final_bid>0, so a live
-- lot can't surface as its own comp.
create or replace function match_cannons_comps_by_vector(
  query_embedding vector(768),
  match_count int default 5,
  min_sim float default 0.75
)
returns table (
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
set statement_timeout to '30s'
as $$
  select
    s.auction_safe_id, s.item_id,
    1 - (n.embedding <=> query_embedding) as similarity,
    s.title, s.final_bid, s.sold_at, s.image_url, s.detail_url,
    s.auction_title, s.source
  from nomic_embeddings n
  join sold_lots s
    on s.auction_safe_id = n.auction_safe_id and s.item_id = n.item_id
  where s.final_bid is not null and s.final_bid > 0
    and 1 - (n.embedding <=> query_embedding) >= min_sim
  order by n.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

revoke execute on function match_cannons_comps_by_vector(vector, int, float)
  from public, anon;
grant execute on function match_cannons_comps_by_vector(vector, int, float)
  to authenticated, service_role;

-- Per-user daily scan ledger + atomic cap. record_resale_scan inserts a row and
-- returns whether the user is still under the daily cap, in one statement (no
-- read-then-write race). Returns true when the call is allowed to hit the paid API.
create table if not exists resale_scan_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists resale_scan_log_user_day
  on resale_scan_log (user_id, created_at);
alter table resale_scan_log enable row level security;
-- No policies: only the service-role edge fn writes/reads (bypasses RLS).

create or replace function record_resale_scan(
  p_user_id uuid,
  daily_cap int default 50
)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  used int;
begin
  insert into resale_scan_log (user_id) values (p_user_id);
  select count(*) into used
  from resale_scan_log
  where user_id = p_user_id and created_at >= now() - interval '1 day';
  return used <= daily_cap;
end;
$$;

revoke execute on function record_resale_scan(uuid, int) from public, anon, authenticated;
grant execute on function record_resale_scan(uuid, int) to service_role;

-- Retention: keep the ledger small. (Run from a scheduled job or the daily
-- scrape; documented here so it isn't forgotten.)
-- delete from resale_scan_log where created_at < now() - interval '7 days';
