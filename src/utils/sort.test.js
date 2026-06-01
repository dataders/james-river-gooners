import test from 'node:test'
import assert from 'node:assert/strict'
import { sortItems, SORT_OPTIONS } from './sort.js'

// Build a slash-formatted local datetime `h` hours from now — the Maxanet
// shape parseAuctionDate reads as local time (matching the on-card timer).
function inHours(h) {
  const d = new Date(Date.now() + h * 3_600_000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const items = [
  { id: 'a', currentBid: 50, totalBids: 2, endDate: inHours(50) },
  { id: 'b', currentBid: 10, totalBids: 9, endDate: inHours(1) },
  { id: 'c', currentBid: 30, totalBids: 0, endDate: inHours(5) },
  { id: 'd', currentBid: 5, totalBids: 1, endDate: null }, // no end date
]
const ids = (arr) => arr.map((i) => i.id)

test('empty/unknown sort key returns the original array reference', () => {
  assert.equal(sortItems(items, ''), items)
  assert.equal(sortItems(items, 'nope'), items)
})

test('sortItems does not mutate the input array', () => {
  const before = ids(items)
  sortItems(items, 'priceAsc')
  assert.deepEqual(ids(items), before)
})

test('ending soonest puts the nearest end first and dateless lots last', () => {
  assert.deepEqual(ids(sortItems(items, 'ending')), ['b', 'c', 'a', 'd'])
})

test('ending latest puts the furthest end first and dateless lots last', () => {
  assert.deepEqual(ids(sortItems(items, 'endingLast')), ['a', 'c', 'b', 'd'])
})

test('price low to high orders by ascending current bid', () => {
  assert.deepEqual(ids(sortItems(items, 'priceAsc')), ['d', 'b', 'c', 'a'])
})

test('price high to low orders by descending current bid', () => {
  assert.deepEqual(ids(sortItems(items, 'priceDesc')), ['a', 'c', 'b', 'd'])
})

test('most bids orders by descending total bids', () => {
  assert.deepEqual(ids(sortItems(items, 'bids')), ['b', 'a', 'd', 'c'])
})

test('ending sort handles ISO (HiBid) and Maxanet dates together', () => {
  // Regression: a naive dash→slash swap corrupts ISO 8601 strings, sending
  // every HiBid lot to the bottom. parseAuctionDate parses both forms, so the
  // ISO lot must interleave by its real end time, not sort last.
  const isoIn = (h) => new Date(Date.now() + h * 3_600_000).toISOString()
  const mixed = [
    { id: 'maxLate', endDate: inHours(20) },
    { id: 'isoSoon', endDate: isoIn(2) },
    { id: 'maxSoon', endDate: inHours(5) },
    { id: 'none', endDate: null },
  ]
  assert.deepEqual(
    ids(sortItems(mixed, 'ending')),
    ['isoSoon', 'maxSoon', 'maxLate', 'none']
  )
})

test('SORT_OPTIONS leads with Featured then Ending soonest', () => {
  assert.equal(SORT_OPTIONS[0].key, '')
  assert.equal(SORT_OPTIONS[1].key, 'ending')
  // every option has a non-empty label
  for (const o of SORT_OPTIONS) assert.ok(o.label.length > 0)
})
