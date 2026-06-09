import { supabase } from '../lib/supabase'
import { groupSupabaseCannonsComps } from '../utils/cannonsComps.js'
import { fetchAllRows } from '../utils/supabasePaging.ts'
import { useByAuctionResource } from './useByAuctionResource.ts'

// Read one auction's Cannon's comps from the `public_cannons_comps` view (#132
// part 3), paging past the 1000-row cap, then reshape to the read-model shape. A
// read error yields no comps for the auction rather than throwing, so one
// failure never blanks the grid.
async function fetchOne(id: string) {
  try {
    const client = supabase
    if (!client) return { id, items: {} }
    const rows = await fetchAllRows((from, to) =>
      client.from('public_cannons_comps').select('*').eq('auction_safe_id', id).range(from, to))
    return { id, items: groupSupabaseCannonsComps(rows) }
  } catch {
    return { id, items: {} }
  }
}

// "Cannon's comps" — similar past lots and what they sold for. Members-only: RLS
// gates `public_cannons_comps` to authenticated sessions (#132 part 3 / #150),
// so logged-out callers read zero rows even at the data layer; `enabled`
// additionally skips the fetch when logged out. Empty when Supabase isn't
// configured. Returns `{ [auctionSafeId]: { [itemId]: { matches: [...] } } }`.
export function useCannonsComps(
  auctionSafeIds: string | string[] | null | undefined,
  enabled = true,
) {
  return useByAuctionResource(auctionSafeIds, fetchOne, enabled)
}
