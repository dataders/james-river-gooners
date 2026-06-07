-- Raise match_cannons_comps' statement timeout (CLIP→Nomic phase 3 follow-up).
--
-- The RPC does one pgvector KNN search per active item in an auction, in a single
-- statement. As nomic_embeddings grew to ~28k vectors, a large active auction
-- (1k+ items) exceeds the default per-request statement timeout (Postgres 57014,
-- "canceling statement due to statement timeout"). Since the function is
-- SECURITY DEFINER, a function-scoped statement_timeout raises the ceiling just
-- for this call. 180s comfortably covers the largest auctions; the comps job
-- runs off-peak and per-auction, so this doesn't affect interactive traffic.

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
