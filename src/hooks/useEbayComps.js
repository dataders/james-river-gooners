import { useEffect, useRef, useState } from 'react'
import { fetchWithRetry } from '../utils/net'

const BASE = import.meta.env.BASE_URL

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

// Accepts a single auction ID string or an array of IDs.
// Returns { [auctionSafeId]: { [itemId]: compData } } for all loaded auctions.
export function useEbayComps(auctionSafeIds) {
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

    Promise.all(
      toFetch.map(id =>
        fetchWithRetry(dataUrl(`data/ebay-comps/${id}.json`))
          .then(resp => {
            if (resp.status === 404) return { id, items: {} }
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            return resp.json().then(data => ({ id, items: data.items || {} }))
          })
          .catch(() => ({ id, items: {} }))
      )
    ).then(results => {
      if (!cancelled) {
        setCompsByAuction(prev => {
          const next = { ...prev }
          for (const { id, items } of results) next[id] = items
          return next
        })
      }
    })

    return () => { cancelled = true }
  }, [auctionSafeIds])

  return compsByAuction
}
