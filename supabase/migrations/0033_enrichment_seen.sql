-- Enrichment reuse cache: every processed lot's input_hash, identified or not.
--
-- The hourly scrape runs in an ephemeral CI container with no committed NDJSON
-- (the read model lives in Supabase; public/data is gitignored), so its only
-- source of "have I already enriched this lot?" is Supabase. But `lot_enrichment`
-- stores ONLY identified (medium/high) lots — the low/no-confidence majority has
-- no row there, so the scrape found no prior hash for them and **re-enriched
-- every unidentified lot every hour** (a standing, mostly-wasted cost: re-paying
-- Haiku vision tokens to get the same "couldn't identify it" answer).
--
-- This table caches the `enrichmentInputHash` for *every* processed lot. The
-- scrape merges it with `lot_enrichment` as its reuse prior: identified lots
-- still reuse their full fields from `lot_enrichment`, and unidentified lots now
-- reuse "empty result, skip the API" from here. Only genuinely new or changed
-- lots (new id, edited text/photos, or a bumped schema/model — all of which
-- change the hash) hit the API.
--
-- Kept separate from `lot_enrichment` on purpose: that table stays a clean,
-- public-read index of *identified products*; this is a scraper-internal,
-- secret-key-only hash cache that never reaches the browser.

create table if not exists enrichment_seen (
  auction_safe_id text not null,
  item_id         text not null,
  input_hash      text not null,
  updated_at      timestamptz not null default now(),
  primary key (auction_safe_id, item_id)
);

-- Scraper-internal: RLS on, no select/insert policy, so only the secret key
-- (service_role, which bypasses RLS) can read or write it. No public exposure.
alter table enrichment_seen enable row level security;
