import test from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../types.ts'
import { validateItems } from './readModelSchema.ts'

// A minimal well-formed lot (only the load-bearing fields the schema checks;
// extra fields are exercised in the passthrough test). Cast through unknown —
// these tests target validation, not the full read-model shape.
const ok = (over: Record<string, unknown> = {}): Item =>
  ({
    id: 'lot-1',
    auctionSafeId: 'auction-a',
    title: 'A thing',
    currentBid: 10,
    totalBids: 3,
    images: ['https://example.com/1.jpg'],
    ...over,
  }) as unknown as Item

test('keeps a well-formed lot', () => {
  const { valid, invalidCount } = validateItems([ok()])
  assert.equal(valid.length, 1)
  assert.equal(invalidCount, 0)
})

test('drops a lot with no id and one with no auctionSafeId', () => {
  const items = [
    ok(),
    ok({ id: '' }), // empty id → broken composite key
    ok({ auctionSafeId: undefined }), // missing grouping key
  ]
  const { valid, invalidCount, sampleReasons } = validateItems(items)
  assert.equal(valid.length, 1)
  assert.equal(invalidCount, 2)
  assert.equal(sampleReasons.length, 2)
  // reason is located: names the offending field
  assert.ok(sampleReasons.some((r) => r.includes('id') || r.includes('auctionSafeId')))
})

test('drops a lot whose numeric field did not coerce', () => {
  const { valid, invalidCount } = validateItems([ok({ currentBid: 'NaN' })])
  assert.equal(valid.length, 0)
  assert.equal(invalidCount, 1)
})

test('returns the original object untouched (extra fields ride along)', () => {
  const enriched = ok({ brand: 'Acme', searchQuery: 'acme widget', images: ['a', 'b'] })
  const { valid } = validateItems([enriched])
  assert.equal(valid[0], enriched) // same reference
  assert.equal((valid[0] as unknown as Record<string, unknown>)['brand'], 'Acme')
})

test('caps sampleReasons at 5 but counts all invalid', () => {
  const bad = Array.from({ length: 9 }, () => ok({ id: '' }))
  const { valid, invalidCount, sampleReasons } = validateItems(bad)
  assert.equal(valid.length, 0)
  assert.equal(invalidCount, 9)
  assert.equal(sampleReasons.length, 5)
})

test('empty input yields empty result', () => {
  const { valid, invalidCount } = validateItems([])
  assert.equal(valid.length, 0)
  assert.equal(invalidCount, 0)
})
