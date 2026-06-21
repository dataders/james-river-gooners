// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCategoryStats, resaleEstimate, marginForItem, maxBidForItem } from './soldHistory.js'
import { COST_MULTIPLIER } from './roiCalc.js'

const compsAt = (price) => ({
  matches: [{ title: 'x', price: { value: String(price), currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' }],
})

test('normalizeCategoryStats coerces the view row to camelCase numbers', () => {
  const stats = normalizeCategoryStats({
    category: 'Silver & Metal', sold_count: '463', median_sold: '38',
    min_sold: '1', max_sold: '6511', last_sold_at: '2026-06-06T00:00:00+00:00',
  })
  assert.equal(stats.category, 'Silver & Metal')
  assert.equal(stats.soldCount, 463)
  assert.equal(stats.medianSold, 38)
  assert.equal(stats.maxSold, 6511)
  assert.equal(stats.lastSoldAt, '2026-06-06T00:00:00+00:00')
})

test('normalizeCategoryStats drops rows with no usable median', () => {
  assert.equal(normalizeCategoryStats(null), null)
  assert.equal(normalizeCategoryStats({}), null)
  assert.equal(normalizeCategoryStats({ category: 'X' }), null)
  assert.equal(normalizeCategoryStats({ category: 'X', median_sold: '0' }), null)
})

test('normalizeCategoryStats falls back invalid optional numbers to null or zero', () => {
  assert.deepEqual(normalizeCategoryStats({
    category: 'X',
    sold_count: 'not-a-number',
    median_sold: '12',
    min_sold: 'bad',
    max_sold: '',
    last_sold_at: '',
  }), {
    category: 'X',
    soldCount: 0,
    medianSold: 12,
    minSold: null,
    maxSold: 0,
    lastSoldAt: null,
  })
})

test('resaleEstimate prefers the per-item eBay median, falls back to category', () => {
  const cat = { medianSold: 30 }
  // eBay comp present → use it, labelled ebay.
  assert.deepEqual(resaleEstimate(compsAt(100), cat), { value: 100, source: 'ebay' })
  // No comp → category baseline.
  assert.deepEqual(resaleEstimate(undefined, cat), { value: 30, source: 'cannons-category' })
  // Neither → null.
  assert.equal(resaleEstimate(undefined, null), null)
})

test('marginForItem returns profit = resale minus all-in cost', () => {
  // category median $300, bid $100 → all-in $127.20 → profit $172.80, from category
  const m = marginForItem(100, undefined, { medianSold: 300 })
  assert.ok(Math.abs(m.profit - (300 - 100 * COST_MULTIPLIER)) < 0.0001)
  assert.equal(m.source, 'cannons-category')
  assert.ok(m.marginPct > 0 && m.marginPct < 1)
  // No signal at all → null.
  assert.equal(marginForItem(100, undefined, null), null)
})

test('maxBidForItem backs resale out through the target margin', () => {
  assert.ok(Math.abs(maxBidForItem(undefined, { medianSold: 300 }, 0) - 235.8490566) < 0.0001)
  assert.equal(maxBidForItem(undefined, null, 0.3), null)
})
