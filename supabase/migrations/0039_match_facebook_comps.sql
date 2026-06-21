create or replace function match_facebook_comps(
  query_embedding vector(768),
  match_count int default 8
) returns table (
  id text,
  title text,
  price_value numeric,
  price_label text,
  sold_date date,
  thumbnail_url text,
  listing_url text,
  last_seen_at timestamptz,
  similarity float
)
language sql stable security invoker as $$
  select
    f.id,
    f.title,
    f.price_value,
    f.price_label,
    f.sold_date,
    f.thumbnail_url,
    f.listing_url,
    f.last_seen_at,
    1 - (f.embedding <=> query_embedding) as similarity
  from facebook_sold_listings f
  where f.embedding is not null
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
