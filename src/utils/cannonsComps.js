// @ts-nocheck
// Helpers for the "Cannon's comps" read model — similar past lots and their
// final hammer prices, precomputed by the scraper (scraper/cannons_comps.py).

function formatSoldPrice(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return ''
  return `$${num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatSoldDate(value) {
  if (!value) return ''
  // Accepts ISO ("2026-05-23T...") and Maxanet ("2026-05-21 23:59:59") shapes.
  const parsed = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return ''
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const SOURCE_LABELS = { cannons: "Cannon's", rasmus: 'Rasmus', hibid: 'HiBid' }

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || (source ? source : 'Auction')
}

// Reshape flat `public_cannons_comps` rows (Supabase, #132 part 3) into the
// `{ [itemId]: { matches: [...] } }` shape normalizeCannonsComps consumes, so
// CannonsComps renders the Supabase source unchanged. Each row is one matched
// past lot; matches for an item are grouped and ordered best (highest
// similarity) first, since PostgREST doesn't guarantee row order.
export function groupSupabaseCannonsComps(rows) {
  const items = {}
  for (const row of rows || []) {
    const itemId = row.item_id
    if (!itemId) continue
    let entry = items[itemId]
    if (!entry) {
      entry = { matches: [] }
      items[itemId] = entry
    }
    entry.matches.push({
      title: row.match_title || '',
      soldPrice: row.sold_price,
      soldDate: row.sold_date || null,
      thumbnailUrl: row.thumbnail_url || null,
      detailUrl: row.detail_url || null,
      auctionTitle: row.auction_title || null,
      source: row.source || null,
      similarity: row.similarity,
    })
  }
  for (const entry of Object.values(items)) {
    entry.matches.sort((a, b) => (Number(b.similarity) || 0) - (Number(a.similarity) || 0))
  }
  return items
}

export function normalizeCannonsComps(comps) {
  return (comps?.matches || [])
    .map(match => ({
      ...match,
      priceLabel: formatSoldPrice(match.soldPrice),
      dateLabel: formatSoldDate(match.soldDate),
      sourceLabel: sourceLabel(match.source),
    }))
    .filter(match => match.title && match.priceLabel)
}

export function hasCannonsComps(comps) {
  return normalizeCannonsComps(comps).length > 0
}

// Median realized price across a comp set — a quick "what did this go for" signal.
export function getCannonsCompMedian(comps) {
  const prices = normalizeCannonsComps(comps)
    .map(m => Number(m.soldPrice))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
  if (prices.length === 0) return null
  const mid = Math.floor(prices.length / 2)
  return prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2
}