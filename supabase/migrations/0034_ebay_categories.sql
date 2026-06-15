-- eBay full US category tree — Phase 2 increment 4 (RFC #290 D4).
-- Populated by scraper/ebay_taxonomy.py via the eBay Taxonomy API
-- (getCategoryTree, marketplace EBAY_US, tree id 0).
-- Scraper-internal: no public SELECT policy (the browser never reads this).
-- Service-role key bypasses RLS for all reads and writes.

create table if not exists ebay_categories (
  category_id   text primary key,
  name          text not null,
  full_path     text not null,
  parent_id     text,
  level         int  not null,
  leaf          boolean not null default true,
  updated_at    timestamptz not null default now()
);

-- Filtered index for leaf-only queries (the only kind used by the leaf lookup).
create index if not exists idx_ebay_categories_leaf
  on ebay_categories (leaf) where leaf = true;

-- pg_trgm index for fast ILIKE prefix + substring searches on full_path.
-- pg_trgm is enabled by default in Supabase projects.
create index if not exists idx_ebay_categories_full_path_trgm
  on ebay_categories using gin (full_path gin_trgm_ops);

alter table ebay_categories enable row level security;
