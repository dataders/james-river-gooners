-- LLM enrichment cost ledger.
--
-- Enrichment spend was effectively invisible until an Anthropic monthly-budget
-- alert fired: the per-run cost was computed in-process (enrich.py) but only
-- emitted as a PostHog event, which is a no-op without GOONERS_POSTHOG_KEY (so
-- ad-hoc/local backfills recorded nothing) and isn't where you'd reconcile
-- spend anyway. This table is a durable, queryable ledger — one row per
-- enrichment unit of work (a Message Batch chunk, or one synchronous run) — so
-- "how much have we spent enriching, and when" is a SQL query, and a creeping
-- per-scrape cost is visible before it crosses a budget threshold.
--
-- Mirrors soldcomps_usage (0025): the scraper appends rows with the secret key
-- (service_role bypasses RLS); nothing reads it from the browser.

create table if not exists enrich_runs (
  id              bigint generated always as identity primary key,
  observed_at     timestamptz not null default now(),
  mode            text,             -- 'batch' | 'sync'
  model           text,
  schema_version  text,
  auction_safe_id text,             -- best-effort; the auction a chunk/run covered
  lots_submitted  integer,          -- lots that hit the API this unit of work
  lots_enriched   integer,          -- of those, the count that got any field
  input_tokens    bigint,
  output_tokens   bigint,
  est_cost_usd    numeric,          -- token-based estimate; batch already halved
  raw             jsonb
);

-- Spend rollups read by recency.
create index if not exists enrich_runs_observed_at_idx
  on enrich_runs (observed_at desc);

-- Scraper-internal: RLS on, no select/insert policy, so only the secret key
-- (service_role, which bypasses RLS) can read or write it. No public exposure.
alter table enrich_runs enable row level security;
