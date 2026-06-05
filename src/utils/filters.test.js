import test from 'node:test'
import assert from 'node:assert/strict'

import { filterItems } from './filters.js'
import { itemKey } from './itemKey.js'

const base = {
  rawCategory: 'Misc',
  currentBid: 10,
  totalBids: 1,
  endDate: '',
}

test('searchIds matches on the composite key, not the bare id', () => {
  // Two items share the bare id "7" across different auctions — a real
  // collision (active vs. archived / Maxanet vs. HiBid).
  const a = { ...base, auctionSafeId: 'auction-a', id: '7' }
  const b = { ...base, auctionSafeId: 'auction-b', id: '7' }
  const items = [a, b]

  // A search hit for only item `a` must not drag in item `b`.
  const searchIds = new Set([itemKey(a)])
  const result = filterItems(items, { excludedCategories: [], searchIds })

  assert.deepEqual(result, [a])
})

test('null searchIds applies no search filter', () => {
  const a = { ...base, auctionSafeId: 'auction-a', id: '1' }
  const b = { ...base, auctionSafeId: 'auction-b', id: '2' }
  const result = filterItems([a, b], { excludedCategories: [], searchIds: null })
  assert.deepEqual(result, [a, b])
})

test('minBidders / maxBidders filter on uniqueBidders', () => {
  const low = { ...base, id: '1', uniqueBidders: 1 }
  const mid = { ...base, id: '2', uniqueBidders: 3 }
  const high = { ...base, id: '3', uniqueBidders: 6 }
  const items = [low, mid, high]

  assert.deepEqual(
    filterItems(items, { excludedCategories: [], minBidders: 3 }),
    [mid, high]
  )
  assert.deepEqual(
    filterItems(items, { excludedCategories: [], maxBidders: 3 }),
    [low, mid]
  )
  assert.deepEqual(
    filterItems(items, { excludedCategories: [], minBidders: 2, maxBidders: 5 }),
    [mid]
  )
})

test('items without uniqueBidders count as 0 bidders', () => {
  // HiBid lots omit uniqueBidders entirely.
  const hibid = { ...base, id: '1' }
  const cannons = { ...base, id: '2', uniqueBidders: 4 }
  const items = [hibid, cannons]

  // A "at least 1 bidder" floor drops the source that has no bidder data.
  assert.deepEqual(
    filterItems(items, { excludedCategories: [], minBidders: 1 }),
    [cannons]
  )
})
