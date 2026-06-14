-- Per-item corpus coverage for corpus-first reuse (RFC #290, increment 3).
--
-- match_sold_listings (0026) re-ranks a whole auction at generation time. For
-- the corpus-first reuse check the comp fetch needs the inverse: the top-K
-- corpus listings most similar to ONE lot, so it can decide "is this lot already
-- well covered?" before spending a paid SoldComps call. Same KNN, scoped to a
-- single (auction_safe_id, item_id) — a lighter, per-lot statement (60s ceiling).

create or replace function match_sold_listings_for_item(
  p_auction_safe_id text,
  p_item_id text,
  match_count int default 5,
  min_sim float default 0.78
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
set statement_timeout to '60s'
as $$
  select
    c.ebay_item_id, c.sim, c.title, c.sold_price, c.sold_date,
    c.sold_date_label, c.condition, c.thumbnail_url, c.item_web_url
  from nomic_embeddings a
  cross join lateral (
    select
      sl.ebay_item_id, sl.title, sl.sold_price, sl.sold_date,
      sl.sold_date_label, sl.condition, sl.thumbnail_url, sl.item_web_url,
      1 - (e.embedding <=> a.embedding) as sim
    from sold_listing_embeddings e
    join sold_listings sl on sl.ebay_item_id = e.ebay_item_id
    order by e.embedding <=> a.embedding
    limit greatest(1, least(match_count, 20))
  ) c
  where a.auction_safe_id = p_auction_safe_id
    and a.item_id = p_item_id
    and c.sim >= min_sim
  order by c.sim desc;
$$;

grant execute on function match_sold_listings_for_item(text, text, int, float)
  to authenticated, service_role;
