// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSoldcompsParams, parseSoldcompsItems, decideStatus } from '../../supabase/functions/resale-ebay/soldcomps.ts'

test('buildSoldcompsParams sends keyword only by default', () => {
  assert.deepEqual(buildSoldcompsParams('Dewalt DCD777 drill'), { keyword: 'Dewalt DCD777 drill' })
})

test('buildSoldcompsParams adds categoryId when provided', () => {
  assert.deepEqual(buildSoldcompsParams('x', '11700'), { keyword: 'x', categoryId: '11700' })
})

test('parseSoldcompsItems maps + dedupes by url, drops items missing title/price/url', () => {
  const items = [
    { itemId: '1', title: 'A', soldPrice: '50.00', soldCurrency: 'USD', url: 'https://www.ebay.com/itm/1', endedAt: '2026-05-01', imageUrl: 'i', condition: 'Used' },
    { itemId: '1b', title: 'A dup', soldPrice: '60', url: 'https://www.ebay.com/itm/1' }, // dup url
    { title: 'no url', soldPrice: '9' },                                                  // dropped
    { title: 'no price', url: 'https://www.ebay.com/itm/2' },                             // dropped
  ]
  const rows = parseSoldcompsItems(items)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].price, { value: '50.00', currency: 'USD' })
  assert.equal(rows[0].itemWebUrl, 'https://www.ebay.com/itm/1')
  assert.equal(rows[0].ebayItemId, '1')
  assert.ok(rows[0].soldDateLabel, 'soldDateLabel is non-empty when an end date is present')
})

test('decideStatus', () => {
  assert.equal(decideStatus(401, []), 'live_error')
  assert.equal(decideStatus(200, []), 'no_results')
  assert.equal(decideStatus(200, [{}]), 'ok')
})
