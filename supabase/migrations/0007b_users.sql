-- Private analytics table: one row per gooners app user (backend-only).
--
-- RLS is enabled with no public policies, so this table is invisible to any
-- request made with the publishable key. Only the service-role (secret) key
-- can query it — use the Supabase dashboard or a server-side script.
--
-- cannon_bidder_id is the numeric/alphanumeric bidder number Cannon's Auctions
-- assigns on registration. Stored here so you can cross-reference app-user
-- analytics with auction-house bidding activity. Can be populated manually
-- from the dashboard or auto-set by the cannon-proxy Edge Function when it
-- parses a successful bid-history response.

create table if not exists users (
  id                uuid        not null references auth.users (id) on delete cascade,
  email             text,
  cannon_bidder_id  text,
  first_seen_at     timestamptz not null default now(),
  last_sign_in_at   timestamptz,
  primary key (id)
);

-- Enable RLS with no grant policies → the publishable key sees nothing.
-- The service-role key bypasses RLS entirely, so dashboard / secret-key
-- scripts have full access.
alter table users enable row level security;

-- Auto-create a row whenever Supabase Auth creates a new user.
-- security definer + empty search_path prevents privilege escalation.
create or replace function handle_new_user()
  returns trigger
  language plpgsql
  security definer set search_path = ''
as $$
begin
  insert into public.users (id, email, first_seen_at, last_sign_in_at)
  values (
    new.id,
    new.email,
    coalesce(new.created_at, now()),
    new.last_sign_in_at
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();

-- Backfill existing users who signed up before this migration.
insert into public.users (id, email, first_seen_at, last_sign_in_at)
select id, email, coalesce(created_at, now()), last_sign_in_at
from   auth.users
on conflict (id) do nothing;
