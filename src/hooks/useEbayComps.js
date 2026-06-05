import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { groupSupabaseComps } from '../utils/ebayComps'

// PostgREST caps a response at 1000 rows; a busy auction can exceed that
// (items × matches), so reads page until a short page comes back.
const PAGE_SIZE = 1000

// Read one auction's deduped comps from the Supabase `public_auction_comps`
// view, paging past the 1000-row cap, then reshape to the read-model shape.
// Supabase is the sole comps source (#6); a read error yields no comps for the
// auction rather than throwing, so one failure never blanks the whole grid.
async function fetchAuctionComps(id) {
  try {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
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

// Accepts a single auction ID string or an array of IDs.
// Returns { [auctionSafeId]: { [itemId]: compData } } for all loaded auctions.
// When Supabase isn't configured, comps are simply unavailable (empty).
export function useEbayComps(auctionSafeIds) {
  const [compsByAuction, setCompsByAuction] = useState({})
  const fetchedIds = useRef(new Set())

  useEffect(() => {
    if (!isSupabaseConfigured) return

    const ids = Array.isArray(auctionSafeIds)
      ? auctionSafeIds.filter(Boolean)
      : auctionSafeIds ? [auctionSafeIds] : []

    const toFetch = ids.filter(id => !fetchedIds.current.has(id))
    if (toFetch.length === 0) return

    for (const id of toFetch) fetchedIds.current.add(id)

    let cancelled = false

    Promise.all(toFetch.map(fetchAuctionComps)).then(results => {
      if (cancelled) return
      setCompsByAuction(prev => {
        const next = { ...prev }
        for (const { id, items } of results) next[id] = items
        return next
      })
    })

    return () => { cancelled = true }
  }, [auctionSafeIds])

  return compsByAuction
}
