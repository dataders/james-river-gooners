-- SoldComps provider quota ledger (issue #299).
--
-- The eBay comp fetch's start-of-run budget gate used the coarse
-- `comp_query_attempts` count (one row per distinct request, including the ~90%
-- `no_results` rows and the free HTML-scrape fallbacks that never hit the paid
-- `/v1/scrape` meter). That count overcounts real billed calls, so a run could
-- be blocked ("request budget exhausted for now") while the provider's own
-- meter still had thousands of requests left — silently starving the scheduled
-- comps refresh well before the real 5000/mo quota was used.
--
-- #283 already made the provider's `X-Usage-*` response header (remaining quota
-- this period) the authoritative mid-run *stop*. This table caches each observed
-- `remaining` reading so the *start gate* can consult the same authoritative
-- meter instead of the attempt count. The scraper appends one row per run with
-- the secret key (service_role, which bypasses RLS); nothing reads it from the
-- browser.

create table if not exists soldcomps_usage (
  id          bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  remaining   integer not null,
  raw         jsonb
);

-- The gate reads the latest reading (and the day's high, for daily pacing), so
-- order by observed_at; the partial-by-recency reads stay cheap.
create index if not exists soldcomps_usage_observed_at_idx
  on soldcomps_usage (observed_at desc);

-- Scraper-internal: RLS on, no select/insert policy, so only the secret key
-- (service_role, which bypasses RLS) can read or write it. No public exposure.
alter table soldcomps_usage enable row level security;
