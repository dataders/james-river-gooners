import test from 'node:test'
import assert from 'node:assert/strict'

import {
  favoriteKey,
  parseFavoritesCookie,
  serializeFavoritesCookie,
  toggleFavoriteKey,
} from './favorites.js'

test('favoriteKey combines auction and item ids', () => {
  assert.equal(favoriteKey({ auctionSafeId: 'abc', id: '123' }), 'abc:123')
})

test('parseFavoritesCookie returns ids from encoded JSON', () => {
  const value = encodeURIComponent(JSON.stringify(['abc:123', 'def:456']))
  assert.deepEqual(parseFavoritesCookie(`gooners-favorites=${value}; theme=dark`), [
    'abc:123',
    'def:456',
  ])
})

test('serializeFavoritesCookie stores ids only for one year', () => {
  assert.equal(
    serializeFavoritesCookie(['abc:123']),
    `gooners-favorites=${encodeURIComponent(JSON.stringify(['abc:123']))}; path=/; max-age=31536000; SameSite=Lax`,
  )
})

test('toggleFavoriteKey adds and removes ids without duplicates', () => {
  assert.deepEqual(toggleFavoriteKey(['abc:123'], 'def:456'), ['abc:123', 'def:456'])
  assert.deepEqual(toggleFavoriteKey(['abc:123', 'def:456'], 'abc:123'), ['def:456'])
})
