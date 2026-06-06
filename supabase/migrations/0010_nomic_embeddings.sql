-- Nomic Embed (text + vision) 768-dim vectors for pgvector semantic search (#165 / #132).
--
-- Each row stores the fused text+image embedding for one lot, produced by
-- scraper/embed_nomic.py using nomic-embed-text-v1.5 + nomic-embed-vision-v1.5
-- (both project into the same 768-dim space by design). Activated by
-- GOONERS_NOMIC_EMBEDDINGS=1 in the scrape workflow; runs alongside the existing
-- CLIP .embeddings binary sidecars, which remain the primary embedding for the
-- current browser search and Cannon's comps pipeline.
--
-- Future use: edge-function pgvector similarity search (#132) will read this
-- table via a Postgres function, replacing the 40 MB browser WASM approach.

create extension if not exists vector;

create table if not exists nomic_embeddings (
  auction_safe_id  text not null,
  item_id          text not null,
  embedding        vector(768) not null,
  n_images         integer not null default 0,    -- images fused into this vector
  model            text not null default 'nomic-embed-text-v1.5+nomic-embed-vision-v1.5',
  generated_at     timestamptz not null default now(),
  primary key (auction_safe_id, item_id)
);

-- HNSW index for fast ANN cosine-similarity queries (edge function / #132).
create index if not exists nomic_embeddings_hnsw
  on nomic_embeddings using hnsw (embedding vector_cosine_ops);

-- Per-auction lookup (batch reads from the edge function or future comps job).
create index if not exists nomic_embeddings_auction
  on nomic_embeddings (auction_safe_id);

-- Backend writes only (service_role bypasses RLS). No browser-direct reads yet;
-- the edge function will query via a Postgres function with its own auth.
alter table nomic_embeddings enable row level security;
