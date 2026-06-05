import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { groupEnrichmentRows } from '../utils/enrichment'

// PostgREST caps a response at 1000 rows; an auction can have more identified
// lots than that, so reads page until a short page comes back.
const PAGE_SIZE = 1000

// Stable empty result for the unconfigured path, so callers don't see a new
// object identity each render.
const EMPTY = {}

// Read one auction's identified lots from the Supabase `public_lot_enrichment`
// view, paging past the 1000-row cap, then group by item id. A read error yields
// no enrichment for the auction rather than throwing, so one failure never blanks
// the grid — items just fall back to their NDJSON-baked fields.
async function fetchAuctionEnrichment(id) {
  try {
    const rows = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('public_lot_enrichment')
        .select('item_id,brand,model_or_sku,condition,product_url,confidence,model')
        .eq('auction_safe_id', id)
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < PAGE_SIZE) break
    }
    return { id, items: groupEnrichmentRows(rows) }
  } catch {
    return { id, items: {} }
  }
}

// LLM lot enrichment (brand/model/condition/...) from the `public_lot_enrichment`
// view (#155). Unlike comps/sold-history this view is public (no auth gate, see
// 0009_lot_enrichment.sql), so the only gate is Supabase being configured — the
// static/offline build falls back to the NDJSON-baked enrichment fields.
//
// Accepts a single auction id or an array; returns
// { [auctionSafeId]: { [itemId]: enrichmentFields } }. Each auction is fetched
// once and cached, mirroring useEbayComps.
export function useEnrichment(auctionSafeIds) {
  const [byAuction, setByAuction] = useState({})
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

    Promise.all(toFetch.map(fetchAuctionEnrichment)).then(results => {
      if (cancelled) return
      setByAuction(prev => {
        const next = { ...prev }
        for (const { id, items } of results) next[id] = items
        return next
      })
    })

    return () => { cancelled = true }
  }, [auctionSafeIds])

  return isSupabaseConfigured ? byAuction : EMPTY
}
