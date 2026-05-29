import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calcMaxBid,
  calcMedian,
  extractCompPrices,
  getCompMedianPrice,
  isDeal,
  COST_MULTIPLIER,
  DEAL_MARGIN_THRESHOLD,
  DEFAULT_MARGIN,
} from './roiCalc.js'

// ── COST_MULTIPLIER ──────────────────────────────────────────────────────────

test('COST_MULTIPLIER reflects 20% buyer premium + 6% VA sales tax', () => {
  assert.ok(Math.abs(COST_MULTIPLIER - 1.272) < 0.0001)
})

// ── calcMedian ───────────────────────────────────────────────────────────────

test('calcMedian returns null for empty array', () => {
  assert.equal(calcMedian([]), null)
})

test('calcMedian returns the single value for a one-element array', () => {
  assert.equal(calcMedian([50]), 50)
})

test('calcMedian returns middle value for odd-length sorted array', () => {
  assert.equal(calcMedian([10, 30, 50]), 30)
})

test('calcMedian returns middle value for odd-length unsorted array', () => {
  assert.equal(calcMedian([50, 10, 30]), 30)
})

test('calcMedian averages two middle values for even-length array', () => {
  assert.equal(calcMedian([10, 20, 30, 40]), 25)
})

// ── extractCompPrices ─────────────────────────────────────────────────────────

test('extractCompPrices extracts numeric values from normalized comps', () => {
  const comps = [
    { price: { value: '98.00', currency: 'USD' } },
    { price: { value: '55.50', currency: 'USD' } },
  ]
  assert.deepEqual(extractCompPrices(comps), [98, 55.5])
})

test('extractCompPrices skips zero and non-numeric prices', () => {
  const comps = [
    { price: { value: '0', currency: 'USD' } },
    { price: { value: 'n/a' } },
    { price: null },
    { price: { value: '42.00', currency: 'USD' } },
  ]
  assert.deepEqual(extractCompPrices(comps), [42])
})

test('extractCompPrices returns empty array when no valid prices', () => {
  assert.deepEqual(extractCompPrices([]), [])
  assert.deepEqual(extractCompPrices([{ price: null }]), [])
})

// ── calcMaxBid ────────────────────────────────────────────────────────────────

test('calcMaxBid at 0% margin equals ebay price divided by COST_MULTIPLIER', () => {
  const result = calcMaxBid(100, 0)
  assert.ok(Math.abs(result - 100 / COST_MULTIPLIER) < 0.01)
})

test('calcMaxBid at 30% margin leaves 30% gross margin on resale', () => {
  const ebayPrice = 100
  const maxBid = calcMaxBid(ebayPrice, 0.30)
  const totalCost = maxBid * COST_MULTIPLIER
  const impliedMargin = 1 - totalCost / ebayPrice
  assert.ok(Math.abs(impliedMargin - 0.30) < 0.001)
})

test('calcMaxBid never returns a negative value', () => {
  // 110% margin requested — should clamp to 0
  assert.equal(calcMaxBid(50, 1.10), 0)
})

test('calcMaxBid rounds to a sensible value for a real-world case', () => {
  // $98 eBay comp, 30% margin: max bid ≈ $53.93
  const maxBid = calcMaxBid(98, 0.30)
  assert.ok(maxBid > 53 && maxBid < 55)
})

// ── getCompMedianPrice ────────────────────────────────────────────────────────

test('getCompMedianPrice returns null when soldComps is undefined', () => {
  assert.equal(getCompMedianPrice(undefined), null)
})

test('getCompMedianPrice returns null when matches array is empty', () => {
  assert.equal(getCompMedianPrice({ matches: [] }), null)
})

test('getCompMedianPrice returns null when no matches survive normalization', () => {
  // match has no valid eBay item URL — filtered out by normalizeEbaySoldMatches
  const soldComps = {
    matches: [{ title: 'Fake', price: { value: '50.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/sch/i.html?_nkw=fake' }],
  }
  assert.equal(getCompMedianPrice(soldComps), null)
})

test('getCompMedianPrice returns median price for valid comps', () => {
  const soldComps = {
    matches: [
      { title: 'Item A', price: { value: '80.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' },
      { title: 'Item B', price: { value: '100.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/222222222222' },
      { title: 'Item C', price: { value: '90.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/333333333333' },
    ],
  }
  assert.equal(getCompMedianPrice(soldComps), 90)
})

// ── isDeal ────────────────────────────────────────────────────────────────────

test('isDeal returns false when soldComps is undefined', () => {
  assert.equal(isDeal(10, undefined), false)
})

test('isDeal returns false when no comp prices survive normalization', () => {
  assert.equal(isDeal(10, { matches: [] }), false)
})

test('isDeal returns true when implied margin exceeds threshold', () => {
  // eBay comp median $100, current bid $40
  // total cost at $40 = $40 * 1.272 = $50.88
  // implied margin = 1 - 50.88/100 = 49.1% > 25% threshold
  const soldComps = {
    matches: [{ title: 'Item', price: { value: '100.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' }],
  }
  assert.equal(isDeal(40, soldComps), true)
})

test('isDeal returns false when current bid already exceeds max bid at threshold', () => {
  // eBay comp median $100, current bid $90
  // total cost at $90 = $90 * 1.272 = $114.48 > $100 — negative margin
  const soldComps = {
    matches: [{ title: 'Item', price: { value: '100.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' }],
  }
  assert.equal(isDeal(90, soldComps), false)
})

test('isDeal boundary: bid exactly at threshold margin is true', () => {
  // margin threshold is 25% → max cost = $100 * 0.75 = $75 → max bid = $75 / 1.272 ≈ $58.96
  const soldComps = {
    matches: [{ title: 'Item', price: { value: '100.00', currency: 'USD' }, itemWebUrl: 'https://www.ebay.com/itm/111111111111' }],
  }
  const breakEvenBid = (100 * (1 - DEAL_MARGIN_THRESHOLD)) / COST_MULTIPLIER
  // Bid just at break-even for the threshold — implied margin equals threshold exactly
  assert.equal(isDeal(breakEvenBid, soldComps), true)
})
