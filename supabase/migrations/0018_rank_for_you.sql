-- rank_for_you: personalised item ranking via Nomic embedding centroid.
--
-- Takes the user's history (favorites + bids) as parallel arrays of
-- (auction_safe_id, item_id) pairs, computes their embedding centroid,
-- and returns all items in the target auctions ranked by cosine similarity
-- to that centroid. Items without embeddings are simply absent from the
-- result set — the frontend treats missing scores as lowest priority.
--
-- Uses security definer so the underlying nomic_embeddings table (no public
-- RLS) is accessible from the browser with the publishable key, matching the
-- same pattern as match_cannons_comps.

create or replace function rank_for_you(
  history_auction_ids text[],
  history_item_ids    text[],
  target_auction_ids  text[]
)
returns table (
  auction_safe_id text,
  item_id         text,
  similarity      float
)
language sql stable security definer set search_path = public as $$
  with history as (
    select
      unnest(history_auction_ids) as auction_safe_id,
      unnest(history_item_ids)    as item_id
  ),
  centroid as (
    select avg(n.embedding) as vec
    from nomic_embeddings n
    join history h
      on n.auction_safe_id = h.auction_safe_id
     and n.item_id          = h.item_id
  )
  select
    n.auction_safe_id,
    n.item_id,
    (1 - (n.embedding <=> c.vec))::float as similarity
  from nomic_embeddings n, centroid c
  where c.vec is not null
    and n.auction_safe_id = any(target_auction_ids)
  order by n.embedding <=> c.vec
$$;
