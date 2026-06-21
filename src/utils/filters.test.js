// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'

import { filterItems, getGroupedCategories } from './filters.js'
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

test('excludedGroups hides items by normalized group, not rawCategory', () => {
  // Firearm lots carry wildly inconsistent rawCategory strings but all
  // normalize to the Firearms group — excluding the group catches them all.
  const gun = { ...base, id: '1', category: 'Firearms', rawCategory: 'Daisy Pellet Gun' }
  const ammo = { ...base, id: '2', category: 'Firearms', rawCategory: 'AMMO' }
  const lamp = { ...base, id: '3', category: 'Home & Kitchen', rawCategory: 'Lighting' }
  const items = [gun, ammo, lamp]

  assert.deepEqual(
    filterItems(items, { excludedCategories: [], excludedGroups: ['Firearms'] }),
    [lamp]
  )
  // Default-empty excludedGroups leaves everything in.
  assert.deepEqual(
    filterItems(items, { excludedCategories: [] }),
    items
  )
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

test('price and bid bounds drop lots outside the requested range', () => {
  const cheap = { ...base, id: '1', currentBid: 5, totalBids: 0 }
  const target = { ...base, id: '2', currentBid: 25, totalBids: 3 }
  const pricey = { ...base, id: '3', currentBid: 100, totalBids: 9 }
  const items = [cheap, target, pricey]

  assert.deepEqual(
    filterItems(items, { excludedCategories: [], minPrice: 10, maxPrice: 50 }),
    [target]
  )
  assert.deepEqual(
    filterItems(items, { excludedCategories: [], minBids: 1, maxBids: 5 }),
    [target]
  )
})

test('time bounds filter by hours until lot close', () => {
  const now = Date.now()
  const realDateNow = Date.now
  Date.now = () => now
  try {
    const inHours = (h) => new Date(now + h * 3600000).toISOString()
    const soon = { ...base, id: '1', endDate: inHours(1) }
    const target = { ...base, id: '2', endDate: inHours(6) }
    const late = { ...base, id: '3', endDate: inHours(30) }

    assert.deepEqual(
      filterItems([soon, target, late], { excludedCategories: [], minHours: 2, maxHours: 12 }),
      [target]
    )
  } finally {
    Date.now = realDateNow
  }
})

test('raw category exclusions and empty search sets hide matching lots', () => {
  const art = { ...base, id: '1', auctionSafeId: 'a', rawCategory: 'Artwork' }
  const tool = { ...base, id: '2', auctionSafeId: 'a', rawCategory: 'Tools' }

  assert.deepEqual(
    filterItems([art, tool], { excludedCategories: ['Artwork'] }),
    [tool]
  )
  assert.deepEqual(
    filterItems([art, tool], { excludedCategories: [], searchIds: new Set() }),
    []
  )
})

test('getGroupedCategories counts raw categories under normalized groups', () => {
  const items = [
    { ...base, id: '1', category: 'Home', rawCategory: 'Lighting' },
    { ...base, id: '2', category: 'Home', rawCategory: 'Lighting' },
    { ...base, id: '3', category: 'Home', rawCategory: 'Furniture' },
    { ...base, id: '4', category: 'Tools', rawCategory: 'Hand Tools' },
    { ...base, id: '5', category: '', rawCategory: '' },
  ]

  assert.deepEqual(getGroupedCategories(items), [
    {
      group: 'Home',
      totalCount: 3,
      rawCategories: [
        { name: 'Lighting', count: 2 },
        { name: 'Furniture', count: 1 },
      ],
    },
    {
      group: 'Tools',
      totalCount: 1,
      rawCategories: [{ name: 'Hand Tools', count: 1 }],
    },
    {
      group: 'Other',
      totalCount: 1,
      rawCategories: [{ name: 'Other', count: 1 }],
    },
  ])
})
