-- Visual re-rank of eBay comps over the sold-listings corpus (RFC #290, inc 2).
--
-- For every embedded active item in `active_auction`, return its top-K most
-- visually+textually similar sold listings (cosine over the shared 768-dim Nomic
-- space: the lot's `nomic_embeddings` vector vs each listing's
-- `sold_listing_embeddings` vector), joined to `sold_listings` for the price +
-- display fields. This is the "right words, wrong object" filter: keyword search
-- found the candidates, this ranks them by what they actually look like.
--
-- A direct analogue of `match_cannons_comps` (0014/0015): SECURITY DEFINER so the
-- scraper reads across the RLS-locked corpus on the caller's behalf, and a
-- function-scoped 180s statement_timeout covers a large auction's per-item KNN.

create or replace function match_sold_listings(
  active_auction text,
  match_count int default 5,
  min_sim float default 0.78
)
returns table (
  item_id text,
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
set statement_timeout to '180s'
as $$
  select
    a.item_id,
    c.ebay_item_id,
    c.sim,
    c.title,
    c.sold_price,
    c.sold_date,
    c.sold_date_label,
    c.condition,
    c.thumbnail_url,
    c.item_web_url
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
  where a.auction_safe_id = active_auction
    and c.sim >= min_sim
  order by a.item_id, c.sim desc;
$$;

grant execute on function match_sold_listings(text, int, float) to authenticated, service_role;
