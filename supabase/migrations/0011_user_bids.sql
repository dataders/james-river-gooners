-- user_bids: persistent record of lots the authenticated user has bid on.
--
-- Written by the cannon-proxy Edge Function on place_bid success and on
-- get_bids backfill (one-time seed from Maxanet watchlist for existing users
-- with zero rows). Status columns (is_winning, current_bid, min_next_bid) are
-- updated in-place by the refresh_bid_statuses action without creating new rows.
--
-- first_bid_at is set by the DB default on INSERT and never overwritten (the
-- upsert body never includes it, so PostgREST excludes it from the DO UPDATE).
--
-- Browser reads via publishable key (RLS select policy below).
-- All writes go through the service-role Edge Function (no browser write policies).

create table if not exists user_bids (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users(id) on delete cascade,
  auction_item_id     text        not null,
  auction_id          text,
  auction_safe_id     text,
  item_title          text,
  item_category       text,
  bid_amount          numeric,
  first_bid_at        timestamptz not null default now(),
  last_bid_at         timestamptz not null default now(),
  is_winning          boolean,
  current_bid         numeric,
  min_next_bid        numeric,
  item_closed         boolean     not null default false,
  status_refreshed_at timestamptz,
  unique (user_id, auction_item_id)
);

alter table user_bids enable row level security;

-- Authenticated users can read their own rows with the publishable key.
create policy "users read own bids"
  on user_bids for select
  using (auth.uid() = user_id);

-- No insert/update/delete policies — the service-role Edge Function owns writes.
