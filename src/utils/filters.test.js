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
