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
