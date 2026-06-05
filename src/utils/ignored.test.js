import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ignoredKey,
  mergeIgnoredKeys,
  parseIgnoredCookie,
  serializeIgnoredCookie,
  toggleIgnoredKey,
} from './ignored.js'

test('ignoredKey combines auction and item ids', () => {
  assert.equal(ignoredKey({ auctionSafeId: 'abc', id: '123' }), 'abc:123')
})

test('parseIgnoredCookie returns ids from encoded JSON', () => {
  const value = encodeURIComponent(JSON.stringify(['abc:123', 'def:456']))
  assert.deepEqual(parseIgnoredCookie(`gooners-ignored=${value}; theme=dark`), [
    'abc:123',
    'def:456',
  ])
})

test('parseIgnoredCookie is not confused by the favorites cookie', () => {
  const favs = encodeURIComponent(JSON.stringify(['zzz:999']))
  assert.deepEqual(parseIgnoredCookie(`gooners-favorites=${favs}`), [])
})

test('serializeIgnoredCookie stores ids only for one year', () => {
  assert.equal(
    serializeIgnoredCookie(['abc:123']),
    `gooners-ignored=${encodeURIComponent(JSON.stringify(['abc:123']))}; path=/; max-age=31536000; SameSite=Lax`,
  )
})

test('toggleIgnoredKey adds and removes ids without duplicates', () => {
  assert.deepEqual(toggleIgnoredKey(['abc:123'], 'def:456'), ['abc:123', 'def:456'])
  assert.deepEqual(toggleIgnoredKey(['abc:123', 'def:456'], 'abc:123'), ['def:456'])
})

test('mergeIgnoredKeys unions both lists, de-duped, cloud order first', () => {
  assert.deepEqual(
    mergeIgnoredKeys(['abc:123', 'def:456'], ['def:456', 'ghi:789']),
    ['abc:123', 'def:456', 'ghi:789'],
  )
  assert.deepEqual(mergeIgnoredKeys([], ['x:1']), ['x:1'])
  assert.deepEqual(mergeIgnoredKeys(), [])
})
