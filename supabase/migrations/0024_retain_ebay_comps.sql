-- Retain all eBay comp snapshots (SoldComps Phase 2 / RFC #290, D5).
--
-- 0004 added a daily pg_cron job that deletes `ebay_comp_snapshots` rows older
-- than 90 days. Per the resolved D5 decision we now retain the full comp history
-- (it doubles as a sold-price record the corpus/re-rank can draw on), so retire
-- that prune. `cron.unschedule` errors if the job is absent, so guard it.

do $$
begin
  perform cron.unschedule('prune-stale-ebay-comps');
exception
  when others then
    raise notice 'prune-stale-ebay-comps not scheduled; nothing to unschedule';
end $$;
