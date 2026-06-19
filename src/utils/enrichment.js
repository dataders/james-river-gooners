// @ts-nocheck
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

// Compose a display label from the v6 category-aware detail bag (scraper enrich
// v6). `details` is a JSON string of the resale-identifying keys for the lot's
// detailCategory (furniture: style/material/form; art: artist/medium/subject;
// ceramics_glass: maker/pattern/material), stored in category-key order — so
// joining the values reads as a product name ("Mid-century modern walnut
// credenza", "Helen Lord watercolor winter landscape"). Returns '' when absent.
export function detailLabel(item) {
  const raw = (item?.details || '').trim()
  if (!raw) return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const phrase = Object.values(parsed)
    .map(v => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' ')
  if (!phrase) return ''
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

// Parse a JSON-encoded string list (conditionFlags/keyAttributes) into a clean
// array of non-empty strings. The scraper stores these as a JSON string ("" when
// empty) so the Parquet column stays a uniform string; the browser parses them
// here. Returns [] on anything unparseable.
function parseStringList(raw) {
  const s = (raw || '').trim()
  if (!s) return []
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(v => (v == null ? '' : String(v).trim())).filter(Boolean)
}

// Parse the JSON-encoded `secondaryItems` list — the *other* identifiable
// products in a multi-brand lot — into display-ready entries. Each carries its
// own {brand, modelOrSku, productType, searchQuery}; we derive a `label`
// ("Brand Model" or the product type) and keep `searchQuery` so the UI can offer
// a per-product eBay search. Entries with nothing identifiable are dropped.
function parseSecondaryItems(raw) {
  const s = (raw || '').trim()
  if (!s) return []
  let parsed
  try {
    parsed = JSON.parse(s)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(entry => {
      if (!entry || typeof entry !== 'object') return null
      const brand = String(entry.brand || '').trim()
      const model = String(entry.modelOrSku || '').trim()
      const productType = String(entry.productType || '').trim()
      const searchQuery = String(entry.searchQuery || '').trim()
      const label = [brand, model].filter(Boolean).join(' ') || productType
      if (!label) return null
      return { brand, model, productType, searchQuery, label }
    })
    .filter(Boolean)
}

// Returns a display-ready enrichment object for confident lots, or null when
// there's nothing trustworthy to show. `label` is the "Brand Model" product name
// (the most useful field for the "Lot - N" placeholder lots whose own title
// carries no detail), falling back to the category-aware detail descriptor for
// unbranded furniture/art/ceramics whose identity is style/artist, not brand.
// `productUrl` is only kept when it's a real http(s) link. `confidence` is passed
// through so the UI can distinguish medium from high.
export function getDisplayEnrichment(item) {
  if (!isDisplayConfidence(item)) return null
  const brand = (item?.brand || '').trim()
  const model = (item?.modelOrSku || '').trim()
  const label = [brand, model].filter(Boolean).join(' ') || detailLabel(item)
  if (!label) return null
  const condition = (item?.condition || '').trim()
  const rawUrl = (item?.productUrl || '').trim()
  const productUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
  // v4/v5 lot economics + resale risk (#269). `isMixedLot` arrives as the string
  // "true"/"false" (or a bool from the NDJSON), `quantity` as a digit string, and
  // the two flag lists / secondary products as JSON strings — parsed once here so
  // every consumer gets ready-to-render values.
  const isMixedLot = String(item?.isMixedLot ?? '').toLowerCase() === 'true'
  const quantity = (item?.quantity || '').trim()
  const conditionFlags = parseStringList(item?.conditionFlags)
  const keyAttributes = parseStringList(item?.keyAttributes)
  const secondaryItems = parseSecondaryItems(item?.secondaryItems)
  return {
    brand,
    model,
    label,
    condition,
    productUrl,
    confidence: confidenceOf(item),
    productType: (item?.productType || '').trim(),
    searchQuery: (item?.searchQuery || '').trim(),
    isMixedLot,
    quantity,
    conditionFlags,
    keyAttributes,
    secondaryItems,
  }
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
    productType: row?.product_type || '',
    searchQuery: row?.search_query || '',
    condition: row?.condition || '',
    productUrl: row?.product_url || '',
    quantity: row?.quantity || '',
    isMixedLot: row?.is_mixed_lot || '',
    conditionFlags: row?.condition_flags || '',
    keyAttributes: row?.key_attributes || '',
    secondaryItems: row?.secondary_items || '',
    detailCategory: row?.detail_category || '',
    details: row?.details || '',
    detailConfidence: row?.detail_confidence || '',
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