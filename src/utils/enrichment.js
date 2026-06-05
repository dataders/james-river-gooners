// LLM lot-enrichment fields (scraper/enrich.py, #99/#104). The scraper writes
// brand/modelOrSku/condition/productUrl/enrichmentConfidence onto each lot. The
// UI surfaces them when the model was at least moderately confident — generic
// lots enrich to low confidence with empty fields, and we never want to show a
// half-guess as a fact. The display bar is medium-or-high (low/absent stays
// hidden), matching what the scraper mirrors into Supabase.

const DISPLAY_CONFIDENCES = new Set(['high', 'medium'])

function confidenceOf(item) {
  return (item?.enrichmentConfidence || '').toLowerCase()
}

export function isHighConfidence(item) {
  return confidenceOf(item) === 'high'
}

// Whether a lot's enrichment is confident enough to display (medium or high).
export function isDisplayConfidence(item) {
  return DISPLAY_CONFIDENCES.has(confidenceOf(item))
}

// Returns a display-ready enrichment object for confident lots, or null when
// there's nothing trustworthy to show. `label` is the "Brand Model" product name
// (the most useful field for the "Lot - N" placeholder lots whose own title
// carries no detail). `productUrl` is only kept when it's a real http(s) link.
// `confidence` is passed through so the UI can distinguish medium from high.
export function getDisplayEnrichment(item) {
  if (!isDisplayConfidence(item)) return null
  const brand = (item?.brand || '').trim()
  const model = (item?.modelOrSku || '').trim()
  const label = [brand, model].filter(Boolean).join(' ')
  if (!label) return null
  const condition = (item?.condition || '').trim()
  const rawUrl = (item?.productUrl || '').trim()
  const productUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
  return { brand, model, label, condition, productUrl, confidence: confidenceOf(item) }
}

// True when the lot has a trustworthy, display-ready identification (a confident
// brand/model). Drives the "Identified" grid filter — same bar as what the UI
// actually shows, so the toggle never surfaces a lot with nothing to display.
export function hasEnrichment(item) {
  return getDisplayEnrichment(item) !== null
}

// --- Backend-sourced enrichment (#155) ------------------------------------
// Enrichment is dual-written: baked onto each lot in the NDJSON read model, and
// mirrored (medium/high only) into the Supabase `lot_enrichment` table. The UI
// reads the backend copy via `useEnrichment` so refreshed enrichment shows up
// without a re-scrape, and falls back to the NDJSON-baked fields when Supabase
// is unconfigured or a lot has no backend row.

// Map a `public_lot_enrichment` view row (snake_case) onto the item's enrichment
// fields (camelCase), so an overlaid item is indistinguishable from one enriched
// straight off the NDJSON.
export function mapEnrichmentRow(row) {
  return {
    brand: row?.brand || '',
    modelOrSku: row?.model_or_sku || '',
    condition: row?.condition || '',
    productUrl: row?.product_url || '',
    enrichmentConfidence: row?.confidence || '',
    enrichmentModel: row?.model || '',
  }
}

// Group one auction's view rows into { [itemId]: mappedFields }, keyed by the
// stringified item id so it matches the item's `id` regardless of number/string.
export function groupEnrichmentRows(rows) {
  const byItem = {}
  for (const row of rows || []) {
    if (row?.item_id == null) continue
    byItem[String(row.item_id)] = mapEnrichmentRow(row)
  }
  return byItem
}

// Overlay backend enrichment onto items by (auctionSafeId, id). A lot with a
// backend row gets those fields (backend is authoritative + fresher); a lot
// without one keeps its NDJSON-baked fields (the offline/fallback source). The
// original array/item references are preserved when nothing overlays, so
// memoized downstream consumers don't churn.
export function overlayEnrichment(items, byAuction) {
  if (!items || !byAuction) return items || []
  let changed = false
  const next = items.map(item => {
    const fields = byAuction[item.auctionSafeId]?.[String(item.id)]
    if (!fields) return item
    changed = true
    return { ...item, ...fields }
  })
  return changed ? next : items
}
