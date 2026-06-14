// @ts-nocheck
// Supabase eBay-comps fetch helper with an injectable client for testability.
// No Vite / browser dependencies.

import { groupSupabaseComps } from './ebayComps.js'
import { fetchAllRows } from './supabasePaging.ts'

// Fetch one auction's deduped comps from the `public_auction_comps` view,
// paging past the 1000-row PostgREST cap (see supabasePaging), then reshape to
// the read-model shape. Errors are caught and returned as an empty items map so
// one failure never blanks the whole grid. `client` must be a Supabase client
// instance.
export async function fetchAuctionComps(id, client) {
  try {
    const rows = await fetchAllRows((from, to) =>
      client.from('public_auction_comps').select('*').eq('auction_safe_id', id).range(from, to))
    return { id, items: groupSupabaseComps(rows) }
  } catch {
    return { id, items: {} }
  }
}