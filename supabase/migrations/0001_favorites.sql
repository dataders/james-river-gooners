-- Milestone 2 — cloud favorites (issue #91).
--
-- One row per (user, favorited item). `item_key` is the app's globally-unique
-- composite key from src/utils/itemKey.js ("<auctionSafeId>:<id>"), stored
-- verbatim so the browser can read/write without translation.
--
-- Row-level security is what makes it safe to query this table directly from a
-- public browser bundle with the publishable key: a user can only ever see or
-- mutate their own rows.

create table if not exists favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table favorites enable row level security;

-- A single FOR ALL policy covers select/insert/update/delete. USING gates reads
-- and the pre-image of writes; WITH CHECK gates the post-image of inserts and
-- updates, so a user cannot insert rows owned by someone else.
drop policy if exists "own favorites" on favorites;
create policy "own favorites" on favorites
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
