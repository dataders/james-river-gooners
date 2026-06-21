// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { l2normalize, mapSoldListingRows, mapCannonsRows } from '../../supabase/functions/resale-embed/embed.ts'

test('l2normalize returns a unit vector', () => {
  const v = l2normalize([3, 4])
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9)
  assert.ok(Math.abs(v[0] - 0.6) < 1e-9)
})

test('mapSoldListingRows -> UI camelCase with price object', () => {
  const rows = [{ ebay_item_id: '1', similarity: 0.9, title: 'A', sold_price: 50, sold_date: '2026-05-01', sold_date_label: 'May 1', condition: 'Used', thumbnail_url: 't', item_web_url: 'https://www.ebay.com/itm/1' }]
  const out = mapSoldListingRows(rows)
  assert.deepEqual(out[0].price, { value: 50, currency: 'USD' })
  assert.equal(out[0].itemWebUrl, 'https://www.ebay.com/itm/1')
  assert.equal(out[0].similarity, 0.9)
})

test('mapCannonsRows -> CannonsComps shape', () => {
  const rows = [{ comp_item_id: 'x', similarity: 0.8, title: 'B', sold_price: 99, sold_at: '2026-04-01T00:00:00Z', image_url: 'i', detail_url: 'd', auction_title: 'AT', source: 'cannons' }]
  const out = mapCannonsRows(rows)
  assert.equal(out[0].soldPrice, 99)
  assert.equal(out[0].thumbnailUrl, 'i')
  assert.equal(out[0].detailUrl, 'd')
  assert.equal(out[0].source, 'cannons')
})
