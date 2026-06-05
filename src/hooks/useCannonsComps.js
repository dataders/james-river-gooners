import { useEffect, useRef, useState } from 'react'
import { fetchWithRetry } from '../utils/net'

const BASE = import.meta.env.BASE_URL

// Stable empty result for the logged-out (hidden) path.
const EMPTY = {}

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

// "Cannon's comps" — similar past lots and what they sold for. Precomputed in
// the scraper (CLIP similarity vs the archive) and served as a static per-auction
// read model under public/data/cannons-comps/. 404 = "no comps yet" → empty,
// never an error.
async function fetchCannonsComps(id) {
  try {
    const resp = await fetchWithRetry(dataUrl(`data/cannons-comps/${id}.json`))
    if (resp.status === 404) return { id, items: {} }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    return { id, items: data.items || {} }
  } catch {
    return { id, items: {} }
  }
}

// Accepts a single auction ID string or an array of IDs.
// Returns { [auctionSafeId]: { [itemId]: { matches: [...] } } } for all loaded auctions.
// `enabled` hides these from logged-out users alongside the RLS-gated comps so
// the resale-insights cluster is consistently members-only. NOTE: this is a
// UI-level hide only — the static cannons-comps JSON stays directly fetchable
// until it's moved behind auth (follow-up). Defaults true so the offline/static
// site (no auth available) still shows them to everyone.
export function useCannonsComps(auctionSafeIds, enabled = true) {
  const [compsByAuction, setCompsByAuction] = useState({})
  const fetchedIds = useRef(new Set())

  useEffect(() => {
    // Logged out: don't fetch; the hook returns EMPTY below so these stay hidden.
    if (!enabled) return
    const ids = Array.isArray(auctionSafeIds)
      ? auctionSafeIds.filter(Boolean)
      : auctionSafeIds ? [auctionSafeIds] : []

    const toFetch = ids.filter(id => !fetchedIds.current.has(id))
    if (toFetch.length === 0) return

    for (const id of toFetch) fetchedIds.current.add(id)

    let cancelled = false

    Promise.all(toFetch.map(fetchCannonsComps)).then(results => {
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
