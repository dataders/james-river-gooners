import { useEffect, useRef, useState } from 'react'
import { fetchWithRetry } from '../utils/net'

const BASE = import.meta.env.BASE_URL

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
export function useCannonsComps(auctionSafeIds) {
  const [compsByAuction, setCompsByAuction] = useState({})
  const fetchedIds = useRef(new Set())

  useEffect(() => {
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
  }, [auctionSafeIds])

  return compsByAuction
}
