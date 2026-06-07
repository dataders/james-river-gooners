-- Public semantic-search RPC over Nomic embeddings (#165 / CLIP→Nomic migration).
--
-- The browser embeds the search query with nomic-embed-text (transformers.js)
-- and calls this function, which runs the pgvector HNSW cosine search server-
-- side and returns just the matching lot keys + similarity — never the raw
-- vectors. This replaces the old approach of downloading every auction's CLIP
-- .embeddings binary into the browser and scanning it client-side.
--
-- Access: semantic search is a public discovery feature (unlike the members-only
-- resale intelligence in 0008), so the function is SECURITY DEFINER — it reads
-- the RLS-locked nomic_embeddings table on the caller's behalf and is granted to
-- anon + authenticated. It exposes only (auction_safe_id, item_id, similarity).

create or replace function match_lots(
  query_embedding vector(768),
  match_count int default 150
)
returns table (
  auction_safe_id text,
  item_id text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    auction_safe_id,
    item_id,
    1 - (embedding <=> query_embedding) as similarity
  from nomic_embeddings
  order by embedding <=> query_embedding
  limit greatest(1, least(match_count, 500));
$$;

grant execute on function match_lots(vector, int) to anon, authenticated;
