import { supabase } from '../lib/supabase'
import { fetchAuctionComps } from '../utils/compsLoader.js'
import { useByAuctionResource } from './useByAuctionResource.ts'

// Module-level (stable) fetcher so it can be an effect dependency without
// re-running every render.
function fetchOne(id: string) {
  return fetchAuctionComps(id, supabase)
}

// eBay sold comps, keyed `{ [auctionSafeId]: { [itemId]: compData } }`.
// Members-only: RLS gates `public_auction_comps` to authenticated sessions
// (migration 0008), so `enabled` (= signed in) skips the fetch and clears the
// result when logged out; logging in refetches. Unavailable (empty) when
// Supabase isn't configured. See useByAuctionResource for caching/retry details.
export function useEbayComps(
  auctionSafeIds: string | string[] | null | undefined,
  enabled = true,
) {
  return useByAuctionResource('ebay-comps', auctionSafeIds, fetchOne, enabled)
}
