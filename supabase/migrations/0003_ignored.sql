-- Cloud "not interested" list — the mirror of 0001_favorites.sql.
--
-- One row per (user, ignored item). `item_key` is the app's globally-unique
-- composite key from src/utils/itemKey.js ("<auctionSafeId>:<id>"), stored
-- verbatim so the browser can read/write without translation.
--
-- Row-level security is what makes it safe to query this table directly from a
-- public browser bundle with the publishable key: a user can only ever see or
-- mutate their own rows.

create table if not exists ignored (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table ignored enable row level security;

-- A single FOR ALL policy covers select/insert/update/delete. USING gates reads
-- and the pre-image of writes; WITH CHECK gates the post-image of inserts and
-- updates, so a user cannot insert rows owned by someone else.
drop policy if exists "own ignored" on ignored;
create policy "own ignored" on ignored
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
