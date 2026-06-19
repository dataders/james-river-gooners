-- rank_for_you (v2): fold the user's "not interested" list into the taste vector.
--
-- v1 (0018) ranked items by cosine similarity to the centroid of the user's
-- positive history (favorites + bids). This adds the negative signal we were
-- already collecting in `ignored`: classic Rocchio relevance feedback —
--
--     taste = avg(liked)  −  ignored_weight · avg(ignored)
--
-- which pulls the query vector toward what they save and pushes it away from
-- what they keep dismissing. `ignored_weight` is a defaulted parameter so it
-- can be tuned per-call (e.g. driven by a feature flag) without a migration.
--
-- pgvector has no scalar·vector operator, so the weight is applied as an
-- element-wise multiply against a constant vector (array_fill → vector(768),
-- matching nomic_embeddings.embedding's dimension).
--
-- The two ignored arrays default to empty, so the old 3-arg call shape (any
-- frontend still on the previous bundle) resolves here unchanged and behaves
-- exactly like v1. security definer is retained so the RLS-less
-- nomic_embeddings table stays reachable with the publishable key.

drop function if exists rank_for_you(text[], text[], text[]);

create or replace function rank_for_you(
  history_auction_ids text[],
  history_item_ids    text[],
  target_auction_ids  text[],
  ignored_auction_ids text[]  default '{}',
  ignored_item_ids    text[]  default '{}',
  ignored_weight      float   default 0.5
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
  ignored as (
    select
      unnest(ignored_auction_ids) as auction_safe_id,
      unnest(ignored_item_ids)    as item_id
  ),
  pos as (
    select avg(n.embedding) as vec
    from nomic_embeddings n
    join history h
      on n.auction_safe_id = h.auction_safe_id
     and n.item_id          = h.item_id
  ),
  neg as (
    select avg(n.embedding) as vec
    from nomic_embeddings n
    join ignored g
      on n.auction_safe_id = g.auction_safe_id
     and n.item_id          = g.item_id
  ),
  taste as (
    -- No ignored signal (or none of them embedded) → fall back to the positive
    -- centroid, so behaviour with an empty ignore list is identical to v1.
    select case
             when neg.vec is null then pos.vec
             else pos.vec - (neg.vec * array_fill(ignored_weight::float8, array[768])::vector)
           end as vec
    from pos, neg
  )
  select
    n.auction_safe_id,
    n.item_id,
    (1 - (n.embedding <=> t.vec))::float as similarity
  from nomic_embeddings n, taste t
  where t.vec is not null
    and n.auction_safe_id = any(target_auction_ids)
  order by n.embedding <=> t.vec
$$;
