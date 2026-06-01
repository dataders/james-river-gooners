import test from 'node:test'
import assert from 'node:assert/strict'

import { compositeKey, itemKey } from './itemKey.js'
import { favoriteKey } from './favorites.js'

test('compositeKey namespaces an id by auction safeId', () => {
  assert.equal(compositeKey('abc', '123'), 'abc:123')
  assert.equal(compositeKey('abc', 123), 'abc:123')
})

test('itemKey builds the composite key from an item', () => {
  assert.equal(itemKey({ auctionSafeId: 'def', id: '456' }), 'def:456')
})

test('the same bare id in different auctions yields distinct keys', () => {
  const a = itemKey({ auctionSafeId: 'auction-a', id: '7' })
  const b = itemKey({ auctionSafeId: 'auction-b', id: '7' })
  assert.notEqual(a, b)
})

test('favoriteKey stays aligned with itemKey', () => {
  const item = { auctionSafeId: 'ghi', id: '789' }
  assert.equal(favoriteKey(item), itemKey(item))
})
