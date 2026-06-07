-- Frozen snapshot corpus for the search-quality benchmark (scripts/search-eval).
--
-- Decoupled from the live nomic_embeddings table (which churns hourly as auctions
-- open/close) so a committed baseline stays reproducible run-to-run. Carries the
-- lot text so judgments and harness output remain readable even after the lots
-- leave the live site. Refresh deliberately (not on a schedule) when you want the
-- benchmark corpus to track new inventory:
--   truncate eval_embeddings;
--   insert into eval_embeddings (...) select ... from nomic_embeddings ...;
-- and re-judge / re-baseline in the same PR.

create table if not exists eval_embeddings (
  auction_safe_id text not null,
  item_id text not null,
  embedding vector(768) not null,
  n_images int,
  title text,
  description text,
  category text,
  primary key (auction_safe_id, item_id)
);

insert into eval_embeddings (auction_safe_id, item_id, embedding, n_images, title, description, category)
select e.auction_safe_id, e.item_id, e.embedding, e.n_images, l.title, l.description, l.category
from nomic_embeddings e
left join lots l using (auction_safe_id, item_id)
on conflict (auction_safe_id, item_id) do nothing;

create index if not exists eval_embeddings_hnsw
  on eval_embeddings using hnsw (embedding vector_cosine_ops);

-- Read only via the SECURITY DEFINER RPC below (no direct anon SELECT).
alter table eval_embeddings enable row level security;

-- Mirror of match_lots over the frozen corpus, with lot text for readable output.
create or replace function match_lots_eval(
  query_embedding vector(768),
  match_count int default 50
)
returns table (
  auction_safe_id text,
  item_id text,
  title text,
  category text,
  similarity float
)
language sql stable security definer set search_path = public as $$
  select auction_safe_id, item_id, title, category, 1 - (embedding <=> query_embedding) as similarity
  from eval_embeddings
  order by embedding <=> query_embedding
  limit greatest(1, least(match_count, 500));
$$;

grant execute on function match_lots_eval(vector, int) to anon, authenticated;
