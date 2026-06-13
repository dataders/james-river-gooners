-- Cloud filter preferences — account-level sync of the browsing filters
-- (excluded categories/groups, price & bid ranges, sort, layout, margin, …).
--
-- Unlike favorites/ignored (one row per item), a user's filter config is a
-- single settings blob, so this is one row per user with the persisted
-- preferences stored verbatim as JSONB. The browser is the only writer; the
-- shape mirrors PERSISTED_KEYS in src/utils/prefs.js. searchQuery is URL-only
-- and intentionally never lands here.
--
-- Row-level security is what makes it safe to read/write directly from the
-- public browser bundle with the publishable key: a user can only ever see or
-- mutate their own row.

create table if not exists filter_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table filter_preferences enable row level security;

-- A single FOR ALL policy covers select/insert/update/delete. USING gates reads
-- and the pre-image of writes; WITH CHECK gates the post-image of inserts and
-- updates, so a user cannot write a row owned by someone else.
drop policy if exists "own filter preferences" on filter_preferences;
create policy "own filter preferences" on filter_preferences
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
