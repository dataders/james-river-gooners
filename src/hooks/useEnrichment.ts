import { supabase } from '../lib/supabase'
import { groupEnrichmentRows } from '../utils/enrichment.js'
import { fetchAllRows } from '../utils/supabasePaging.ts'
import { useByAuctionResource } from './useByAuctionResource.ts'

// Read one auction's identified lots from the `public_lot_enrichment` view,
// paging past the 1000-row cap, then group by item id. A read error yields no
// enrichment for the auction rather than throwing, so one failure never blanks
// the grid — items just fall back to their NDJSON-baked fields.
async function fetchOne(id: string) {
  try {
    const client = supabase
    if (!client) return { id, items: {} }
    const rows = await fetchAllRows((from, to) =>
      client
        .from('public_lot_enrichment')
        .select('item_id,brand,model_or_sku,product_type,search_query,condition,product_url,quantity,is_mixed_lot,condition_flags,key_attributes,secondary_items,detail_category,details,detail_confidence,confidence,model')
        .eq('auction_safe_id', id)
        .range(from, to))
    return { id, items: groupEnrichmentRows(rows) }
  } catch {
    return { id, items: {} }
  }
}

// LLM lot enrichment (brand/model/condition/...) from the `public_lot_enrichment`
// view (#155). Unlike comps/sold-history this view is public (no auth gate, see
// 0009_lot_enrichment.sql), so the only gate is Supabase being configured — the
// static/offline build falls back to the NDJSON-baked enrichment fields.
// Returns `{ [auctionSafeId]: { [itemId]: enrichmentFields } }`.
export function useEnrichment(auctionSafeIds: string | string[] | null | undefined) {
  return useByAuctionResource('enrichment', auctionSafeIds, fetchOne)
}
