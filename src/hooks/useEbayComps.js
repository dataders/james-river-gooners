import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { fetchAuctionComps as _fetchAuctionComps } from '../utils/compsLoader'

// Stable empty result for the logged-out / unconfigured path, so callers don't
// see a new object identity each render.
const EMPTY = {}

function fetchAuctionComps(id) {
  return _fetchAuctionComps(id, supabase)
}

// Accepts a single auction ID string or an array of IDs.
// Returns { [auctionSafeId]: { [itemId]: compData } } for all loaded auctions.
// When Supabase isn't configured, comps are simply unavailable (empty).
// `enabled` gates the read on auth: comps are members-only (RLS, migration
// 0008), so a logged-out caller passes false to skip the fetch and clear any
// previously-loaded comps; logging in flips it true and refetches.
export function useEbayComps(auctionSafeIds, enabled = true) {
  const [compsByAuction, setCompsByAuction] = useState({})
  const fetchedIds = useRef(new Set())

  useEffect(() => {
    // Logged out / unconfigured: don't fetch. The hook returns EMPTY below, so
    // derived UI (card ROI, margin sort) clears; any already-loaded comps stay
    // cached in state and reappear instantly when `enabled` flips back to true.
    if (!isSupabaseConfigured || !enabled) return

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
  }, [auctionSafeIds, enabled])

  return enabled ? compsByAuction : EMPTY
}
