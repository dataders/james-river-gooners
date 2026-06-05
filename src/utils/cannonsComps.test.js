import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCannonsComps,
  hasCannonsComps,
  getCannonsCompMedian,
  sourceLabel,
} from './cannonsComps.js'

test('normalizeCannonsComps formats price, date, and source labels', () => {
  const out = normalizeCannonsComps({
    matches: [
      { title: 'Air compressor', soldPrice: 101.33, soldDate: '2026-05-22 23:59:59', source: 'cannons' },
    ],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].priceLabel, '$101.33')
  assert.equal(out[0].sourceLabel, "Cannon's")
  assert.match(out[0].dateLabel, /2026/)
})

test('normalizeCannonsComps drops matches without a title or price', () => {
  const out = normalizeCannonsComps({
    matches: [
      { title: '', soldPrice: 50 },
      { title: 'Lamp', soldPrice: 0 },
      { title: 'Chair', soldPrice: 30 },
    ],
  })
  assert.deepEqual(out.map(m => m.title), ['Chair'])
})

test('hasCannonsComps reflects whether any valid match survives', () => {
  assert.equal(hasCannonsComps(undefined), false)
  assert.equal(hasCannonsComps({ matches: [] }), false)
  assert.equal(hasCannonsComps({ matches: [{ title: 'X', soldPrice: 10 }] }), true)
})

test('getCannonsCompMedian returns the median realized price', () => {
  assert.equal(
    getCannonsCompMedian({ matches: [
      { title: 'a', soldPrice: 10 },
      { title: 'b', soldPrice: 30 },
      { title: 'c', soldPrice: 20 },
    ] }),
    20,
  )
  assert.equal(getCannonsCompMedian({ matches: [] }), null)
})

test('sourceLabel maps known sources and falls back', () => {
  assert.equal(sourceLabel('rasmus'), 'Rasmus')
  assert.equal(sourceLabel('hibid'), 'HiBid')
  assert.equal(sourceLabel(''), 'Auction')
})
