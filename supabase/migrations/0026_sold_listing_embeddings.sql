-- Nomic embeddings for the sold-listings corpus (Phase 2 / RFC #290, increment 2).
--
-- One fused text+image vector per eBay sold listing, produced by
-- scraper/embed_sold_listings.py with the SAME #165 stack the lots use
-- (nomic-embed-text-v1.5 + nomic-embed-vision-v1.5, 768-dim shared space):
-- normalize(text("search_document: " + title + condition + raw_json text) +
-- mean(vision(thumbnail))). Because it lives in the same space as
-- `nomic_embeddings`, a lot's vector and a listing's vector compare
-- apples-to-apples — that's what `match_sold_listings` (0026) exploits to
-- re-rank a lot's candidate comps by hybrid text+image similarity ("right words,
-- wrong object").

create extension if not exists vector;

create table if not exists sold_listing_embeddings (
  ebay_item_id  text primary key,
  embedding     vector(768) not null,
  n_images      integer not null default 0,
  model         text not null default 'nomic-embed-text-v1.5+nomic-embed-vision-v1.5',
  generated_at  timestamptz not null default now()
);

-- HNSW index for fast ANN cosine search (the re-rank RPC).
create index if not exists sold_listing_embeddings_hnsw
  on sold_listing_embeddings using hnsw (embedding vector_cosine_ops);

-- Backend writes only (service_role bypasses RLS); no browser-direct reads.
alter table sold_listing_embeddings enable row level security;
