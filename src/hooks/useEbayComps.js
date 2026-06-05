import { useEffect, useRef, useState } from 'react'
import { fetchWithRetry } from '../utils/net'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { groupSupabaseComps } from '../utils/ebayComps'

const BASE = import.meta.env.BASE_URL
// PostgREST caps a response at 1000 rows; a busy auction can exceed that
// (items × matches), so reads page until a short page comes back.
const PAGE_SIZE = 1000

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

// Static JSON read model (the CDN fallback, and the only path when Supabase
// isn't configured). 404 = "no comps yet" → empty, never an error.
async function fetchStaticComps(id) {
  try {
    const resp = await fetchWithRetry(dataUrl(`data/ebay-comps/${id}.json`))
    if (resp.status === 404) return { id, items: {} }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    return { id, items: data.items || {} }
  } catch {
    return { id, items: {} }
  }
}

// Read one auction's deduped comps from the Supabase `public_auction_comps`
// view, paging past the 1000-row cap, then reshape to the read-model shape.
async function fetchSupabaseRows(id) {
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
  return groupSupabaseComps(rows)
}

// Supabase first; fall back to the CDN when Supabase errors or has nothing for
// this auction yet — keeps comps working during the #6 cutover while both the
// view and the static files are populated.
async function fetchCompsViaSupabase(id) {
  try {
    const items = await fetchSupabaseRows(id)
    if (Object.keys(items).length > 0) return { id, items }
  } catch {
    // fall through to the CDN read model
  }
  return fetchStaticComps(id)
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
    const fetchOne = isSupabaseConfigured ? fetchCompsViaSupabase : fetchStaticComps

    Promise.all(toFetch.map(fetchOne)).then(results => {
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
