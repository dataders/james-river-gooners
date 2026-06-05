// LLM lot-enrichment fields (scraper/enrich.py, #99/#104). The scraper writes
// brand/modelOrSku/condition/productUrl/enrichmentConfidence onto each lot. The
// UI surfaces them only when the model was confident — generic lots enrich to
// low confidence with empty fields, and we never want to show a half-guess as a
// fact. Gated on high confidence per the product call.

export function isHighConfidence(item) {
  return (item?.enrichmentConfidence || '').toLowerCase() === 'high'
}

// Returns a display-ready enrichment object for high-confidence lots, or null
// when there's nothing trustworthy to show. `label` is the "Brand Model" product
// name (the most useful field for the "Lot - N" placeholder lots whose own title
// carries no detail). `productUrl` is only kept when it's a real http(s) link.
export function getDisplayEnrichment(item) {
  if (!isHighConfidence(item)) return null
  const brand = (item?.brand || '').trim()
  const model = (item?.modelOrSku || '').trim()
  const label = [brand, model].filter(Boolean).join(' ')
  if (!label) return null
  const condition = (item?.condition || '').trim()
  const rawUrl = (item?.productUrl || '').trim()
  const productUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : ''
  return { brand, model, label, condition, productUrl }
}

// True when the lot has a trustworthy, display-ready identification (a confident
// brand/model). Drives the "Identified" grid filter — same bar as what the UI
// actually shows, so the toggle never surfaces a lot with nothing to display.
export function hasEnrichment(item) {
  return getDisplayEnrichment(item) !== null
}
