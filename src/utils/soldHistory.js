// @ts-nocheck
// Cannon's per-category sold-price history (#95/#96/#97). Normalizes rows from
// the Supabase `public_category_sold_stats` view and turns the category baseline
// — plus per-item eBay comps when present — into a resale/margin estimate the
// grid ranks by (#97) and the detail panel shows (#96).

import { COST_MULTIPLIER, getCompMedianPrice, calcMaxBid } from './roiCalc.js'

const toNum = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Normalize one `public_category_sold_stats` row to camelCase numbers, or null
 * when it has no usable median.
 */
export function normalizeCategoryStats(row) {
  if (!row || !row.category) return null
  const medianSold = toNum(row.median_sold)
  if (medianSold == null || medianSold <= 0) return null
  return {
    category: row.category,
    soldCount: toNum(row.sold_count) ?? 0,
    medianSold,
    minSold: toNum(row.min_sold),
    maxSold: toNum(row.max_sold),
    lastSoldAt: row.last_sold_at || null,
  }
}

/**
 * Best available resale signal for a lot: the per-item eBay comp median when we
 * have one (most specific), else the lot's Cannon's category median sold (the
 * #95 baseline, so a lot with no close comp still has a price to compare).
 * Returns { value, source } or null.
 */
export function resaleEstimate(soldComps, categoryStats) {
  const ebayMedian = getCompMedianPrice(soldComps)
  if (ebayMedian) return { value: ebayMedian, source: 'ebay' }
  if (categoryStats && categoryStats.medianSold > 0) {
    return { value: categoryStats.medianSold, source: 'cannons-category' }
  }
  return null
}

/**
 * Estimated resale margin for a lot: resale estimate minus the all-in cost
 * (current bid + buyer's premium + sales tax). Returns null when there's no
 * resale signal. `profit` is in dollars; `marginPct` is the fraction of resale.
 */
export function marginForItem(currentBid, soldComps, categoryStats) {
  const resale = resaleEstimate(soldComps, categoryStats)
  if (!resale) return null
  const profit = resale.value - (currentBid || 0) * COST_MULTIPLIER
  return {
    ...resale,
    profit,
    marginPct: resale.value > 0 ? profit / resale.value : 0,
  }
}

/**
 * Recommended max bid for a lot: the resale estimate (eBay comp median, else the
 * Cannon's category median) backed out through the target `marginFraction` and
 * the all-in cost multiplier. Returns null when there's no resale signal, so the
 * "Max bid" sort (#) can sink unpriced lots to the bottom.
 */
export function maxBidForItem(soldComps, categoryStats, marginFraction) {
  const resale = resaleEstimate(soldComps, categoryStats)
  if (!resale) return null
  return calcMaxBid(resale.value, marginFraction)
}