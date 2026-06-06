// Supabase eBay-comps fetch helper with an injectable client for testability.
// No Vite / browser dependencies.

import { groupSupabaseComps } from './ebayComps.js'

const PAGE_SIZE = 1000

// Fetch one auction's deduped comps from the `public_auction_comps` view,
// paging past the 1000-row PostgREST cap, then reshape to the read-model shape.
// Errors are caught and returned as an empty items map so one failure never
// blanks the whole grid. `client` must be a Supabase client instance.
export async function fetchAuctionComps(id, client) {
  try {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await client
        .from('public_auction_comps')
        .select('*')
        .eq('auction_safe_id', id)
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }
    return { id, items: groupSupabaseComps(rows) }
  } catch {
    return { id, items: {} }
  }
}
