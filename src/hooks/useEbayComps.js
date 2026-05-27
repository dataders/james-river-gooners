import { useEffect, useState } from 'react'

const BASE = import.meta.env.BASE_URL

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

export function useEbayComps(auctionSafeId) {
  const [compsByAuction, setCompsByAuction] = useState({})

  useEffect(() => {
    if (!auctionSafeId || compsByAuction[auctionSafeId]) return

    let cancelled = false

    fetch(dataUrl(`data/ebay-comps/${auctionSafeId}.json`))
      .then(resp => {
        if (resp.status === 404) return { items: {} }
        if (!resp.ok) throw new Error(`Failed to load eBay comps: ${resp.status}`)
        return resp.json()
      })
      .then(data => {
        if (!cancelled) {
          setCompsByAuction(prev => ({
            ...prev,
            [auctionSafeId]: data.items || {},
          }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCompsByAuction(prev => ({
            ...prev,
            [auctionSafeId]: {},
          }))
        }
      })

    return () => { cancelled = true }
  }, [auctionSafeId, compsByAuction])

  return auctionSafeId ? compsByAuction[auctionSafeId] || {} : {}
}
