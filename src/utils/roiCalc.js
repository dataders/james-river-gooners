import { normalizeEbaySoldMatches } from './ebayComps.js'

const BUYERS_PREMIUM = 0.20
const SALES_TAX = 0.06
export const COST_MULTIPLIER = (1 + BUYERS_PREMIUM) * (1 + SALES_TAX) // 1.272
export const DEAL_MARGIN_THRESHOLD = 0.25
export const DEFAULT_MARGIN = 0.30

export function extractCompPrices(normalizedComps) {
  return normalizedComps
    .map(comp => {
      const val = Number(comp.price?.value)
      return Number.isFinite(val) && val > 0 ? val : null
    })
    .filter(v => v !== null)
}

export function calcMedian(prices) {
  if (!prices.length) return null
  const sorted = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function getCompMedianPrice(soldComps) {
  const normalized = normalizeEbaySoldMatches(soldComps)
  const prices = extractCompPrices(normalized)
  return calcMedian(prices)
}

export function calcMaxBid(targetResaleValue, marginFraction) {
  return Math.max(0, targetResaleValue * (1 - marginFraction) / COST_MULTIPLIER)
}

export function isDeal(currentBid, soldComps) {
  const median = getCompMedianPrice(soldComps)
  if (!median) return false
  return (1 - (currentBid * COST_MULTIPLIER) / median) >= DEAL_MARGIN_THRESHOLD
}

// Estimated resale profit in dollars: eBay comp median minus the all-in cost
// (current bid + buyer's premium + sales tax). Returns null when there are no
// usable comps, so callers can distinguish "no margin" from "unknown".
export function estimatedProfit(currentBid, soldComps) {
  const median = getCompMedianPrice(soldComps)
  if (median == null) return null
  return median - currentBid * COST_MULTIPLIER
}

// Whether a lot clears a minimum estimated profit. A null threshold is "off"
// (everything passes); a lot with no comps can't be shown to clear the bar.
export function meetsMinProfit(currentBid, soldComps, minProfit) {
  if (minProfit == null) return true
  const profit = estimatedProfit(currentBid, soldComps)
  return profit != null && profit >= minProfit
}
