import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { groupSupabaseCannonsComps } from '../utils/cannonsComps'

// PostgREST caps a response at 1000 rows; a busy auction (items × matches) can
// exceed that, so reads page until a short page comes back.
const PAGE_SIZE = 1000

// Stable empty result for the logged-out / unconfigured path.
const EMPTY = {}

// Read one auction's Cannon's comps from the Supabase `public_cannons_comps`
// view (#132 part 3), paging past the 1000-row cap, then reshape to the
// read-model shape. A read error yields no comps for the auction rather than
// throwing, so one failure never blanks the grid.
async function fetchAuctionCannonsComps(id) {
  try {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('public_cannons_comps')
        .select('*')
        .eq('auction_safe_id', id)
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }
    return { id, items: groupSupabaseCannonsComps(rows) }
  } catch {
    return { id, items: {} }
  }
}

// "Cannon's comps" — similar past lots and what they sold for. Members-only:
// read from the Supabase `public_cannons_comps` view, which RLS gates to
// authenticated sessions (#132 part 3 / #150), so logged-out callers read zero
// rows even at the data layer. `enabled` additionally skips the fetch when
// logged out (returning empty); a later login refetches. When Supabase isn't
// configured, comps are simply unavailable.
//
// Accepts a single auction ID string or an array of IDs. Returns
// { [auctionSafeId]: { [itemId]: { matches: [...] } } } for all loaded auctions.
export function useCannonsComps(auctionSafeIds, enabled = true) {
  const [compsByAuction, setCompsByAuction] = useState({})
  const fetchedIds = useRef(new Set())

  useEffect(() => {
    // Logged out / unconfigured: don't fetch; the hook returns EMPTY below.
    if (!isSupabaseConfigured || !enabled) return

    const ids = Array.isArray(auctionSafeIds)
      ? auctionSafeIds.filter(Boolean)
      : auctionSafeIds ? [auctionSafeIds] : []

    const toFetch = ids.filter(id => !fetchedIds.current.has(id))
    if (toFetch.length === 0) return

    for (const id of toFetch) fetchedIds.current.add(id)

    let cancelled = false

    Promise.all(toFetch.map(fetchAuctionCannonsComps)).then(results => {
      if (cancelled) return
      setCompsByAuction(prev => {
        const next = { ...prev }
        for (const { id, items } of results) next[id] = items
        return next
      })
    })

    return () => { cancelled = true }
  }, [auctionSafeIds, enabled])

  return enabled ? compsByAuction : EMPTY
}
