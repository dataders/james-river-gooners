-- Gate the resale-intelligence data behind authentication (members-only comps).
--
-- The most valuable derived data — eBay sold comps (ebay_comp_snapshots →
-- public_auction_comps) and Cannon's sold-price history (sold_lots →
-- public_sold_lots / public_category_sold_stats) — was world-readable through
-- the publishable (anon) key. This restricts SELECT on the two base tables to
-- authenticated sessions only, so a logged-out browser (or a raw anon API call)
-- reads zero rows. The listings themselves (lots / public_active_lots),
-- favorites, and ignored lists are intentionally left public — only the resale
-- intelligence is gated.
--
-- Mechanics:
--   * The scraper writes with the secret key (service_role), which bypasses RLS
--     entirely, so ingestion is unaffected.
--   * The public_* views are `security_invoker = on`, so they inherit these
--     base-table policies: an anon query still *executes* and simply returns no
--     rows (rather than erroring), which the SPA renders as a "log in to unlock"
--     placeholder. No grant changes are needed.
--   * comp_query_attempts / comp_item_freshness are granted to service_role
--     only and the scraper reads them with the secret key, so they're unaffected.
--
-- Rollback: re-create each policy with `using (true)` to make the data public
-- again.

-- eBay comps -----------------------------------------------------------------
drop policy if exists "public read comps" on ebay_comp_snapshots;
drop policy if exists "authenticated read comps" on ebay_comp_snapshots;
create policy "authenticated read comps" on ebay_comp_snapshots
  for select using ((select auth.uid()) is not null);

-- Cannon's sold-price history ------------------------------------------------
drop policy if exists "public read sold lots" on sold_lots;
drop policy if exists "authenticated read sold lots" on sold_lots;
create policy "authenticated read sold lots" on sold_lots
  for select using ((select auth.uid()) is not null);
