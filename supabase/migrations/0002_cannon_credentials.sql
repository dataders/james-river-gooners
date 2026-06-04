-- Cannon's/Maxanet credential storage for the "My Bids" feature.
--
-- Passwords are AES-GCM encrypted by the cannon-proxy Edge Function before
-- being stored here — the plaintext never touches this table or the DB wire.
-- RLS is enabled with no policies so the publishable key cannot reach this
-- table at all; every read/write goes through the service-role Edge Function.

create table if not exists cannon_credentials (
  user_id             uuid        not null references auth.users (id) on delete cascade,
  cannon_username     text        not null,
  cannon_password_enc text        not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (user_id)
);

alter table cannon_credentials enable row level security;
-- No policies — service role (Edge Function) only.
