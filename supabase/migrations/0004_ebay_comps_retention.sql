-- eBay comps retention (issue #6, step 5 / open questions: "stale data cleanup").
--
-- `ebay_comp_snapshots` is append-only: every scrape inserts a fresh row per
-- (item, matched eBay listing), and `public_auction_comps` only ever surfaces
-- the latest fetch per (auction, item, source_query). A row older than the
-- retention window is therefore never the latest for an active auction (which
-- re-fetches on each run) -- it's a comp for an auction that has ended and
-- stopped being scraped. Pruning those keeps the free-tier 500 MB database from
-- accumulating dead snapshots without ever removing a live comp.

-- Supabase installs pg_cron into the `cron` schema; this is a no-op if another
-- migration already enabled it.
create extension if not exists pg_cron;

-- Prune snapshots not refreshed in 90 days. `ingested_at` is server-filled and
-- never null (unlike the client-supplied `fetched_at`), so it's the reliable
-- age signal. `cron.schedule` upserts by job name, so re-running this migration
-- just rewrites the schedule -- it stays idempotent.
select cron.schedule(
  'prune-stale-ebay-comps',
  '17 3 * * *',  -- daily at 03:17 UTC, off the top-of-hour scrape cadence
  $$delete from public.ebay_comp_snapshots
      where ingested_at < now() - interval '90 days'$$
);
