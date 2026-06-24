-- Named filter presets: a user can save the current browsing filters under a
-- name and restore them later. Filters are a JSONB blob whose shape mirrors
-- PERSISTED_KEYS in src/utils/prefs.js (same as filter_preferences). Multiple
-- rows per user (one per saved name), keyed on (user_id, name).
--
-- RLS mirrors the pattern in 0021_filter_preferences.sql: a single FOR ALL
-- policy so a user can only ever read or mutate their own rows.

create table if not exists saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint saved_searches_user_name_unique unique (user_id, name)
);

alter table saved_searches enable row level security;

drop policy if exists "own saved searches" on saved_searches;
create policy "own saved searches" on saved_searches
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
