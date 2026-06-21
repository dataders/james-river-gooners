create table if not exists facebook_sold_listings (
  id text primary key,
  keyword text not null,
  title text,
  price_value numeric,
  price_label text,
  sold_date date,
  thumbnail_url text,
  listing_url text,
  location text,
  embedding vector(768),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists facebook_sold_listings_embedding_hnsw
  on facebook_sold_listings using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table facebook_sold_listings enable row level security;

drop policy if exists "authenticated read fb sold" on facebook_sold_listings;
create policy "authenticated read fb sold" on facebook_sold_listings
  for select using ((select auth.uid()) is not null);

create or replace function touch_facebook_sold_listings_last_seen()
returns trigger
language plpgsql
as $$
begin
  new.first_seen_at = old.first_seen_at;
  new.last_seen_at = now();
  return new;
end;
$$;

drop trigger if exists facebook_sold_listings_touch_last_seen on facebook_sold_listings;
create trigger facebook_sold_listings_touch_last_seen
  before update on facebook_sold_listings
  for each row execute function touch_facebook_sold_listings_last_seen();
