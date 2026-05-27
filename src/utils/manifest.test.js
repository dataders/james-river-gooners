import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeManifest } from './manifest.js'

test('normalizes old flat active manifest arrays', () => {
  assert.deepEqual(normalizeManifest(['abc']), [
    {
      safeId: 'abc',
      itemsPath: 'data/items/abc.parquet',
      archived: false,
    },
  ])
})

test('normalizes old flat archive manifest arrays', () => {
  assert.deepEqual(normalizeManifest(['old'], { archived: true }), [
    {
      safeId: 'old',
      itemsPath: 'data/archive/items/old.parquet',
      archived: true,
    },
  ])
})

test('preserves object manifest metadata and item paths', () => {
  assert.deepEqual(
    normalizeManifest({
      auctions: [
        {
          safeId: 'abc',
          title: 'Auction',
          itemCount: 12,
          itemsPath: 'custom/abc.parquet',
        },
      ],
    }),
    [
      {
        safeId: 'abc',
        title: 'Auction',
        itemCount: 12,
        itemsPath: 'custom/abc.parquet',
        archived: false,
      },
    ],
  )
})
