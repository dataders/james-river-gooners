import test from 'node:test'
import assert from 'node:assert/strict'

import { lookupZip } from './geocodeZip.ts'

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}
function notFound() {
  return { ok: false, status: 404, json: () => Promise.resolve({}) }
}

const ZIPPO_RICHMOND = {
  'post code': '23220',
  country: 'United States',
  places: [
    {
      'place name': 'Richmond',
      'state abbreviation': 'VA',
      latitude: '37.5538',
      longitude: '-77.4603',
    },
  ],
}

const CACHE_KEY = 'gooners-zip-cache'

function withMockStorage(fn: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    },
  })

  return fn().finally(() => {
    if (previous) {
      Object.defineProperty(globalThis, 'localStorage', previous)
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage
    }
  })
}

test('resolves a valid zip to coords + label', async () => {
  const result = await lookupZip('23220', { fetchImpl: () => Promise.resolve(okResponse(ZIPPO_RICHMOND)) })
  assert.deepEqual(result, { lat: 37.5538, lng: -77.4603, label: 'Richmond, VA' })
})

test('returns null for a non-5-digit zip without fetching', async () => {
  let called = false
  const r = await lookupZip('123', {
    fetchImpl: async () => {
      await Promise.resolve()
      called = true
      return okResponse(ZIPPO_RICHMOND)
    },
  })
  assert.equal(r, null)
  assert.equal(called, false)
})

test('returns null when the zip is not found (404)', async () => {
  const r = await lookupZip('00000', { fetchImpl: () => Promise.resolve(notFound()) })
  assert.equal(r, null)
})

test('returns null when the payload has no places', async () => {
  const r = await lookupZip('99999', {
    fetchImpl: () => Promise.resolve(okResponse({ 'post code': '99999', places: [] })),
  })
  assert.equal(r, null)
})

test('trims surrounding whitespace in the zip', async () => {
  const result = await lookupZip('  23220 ', { fetchImpl: () => Promise.resolve(okResponse(ZIPPO_RICHMOND)) })
  assert.deepEqual(result, { lat: 37.5538, lng: -77.4603, label: 'Richmond, VA' })
})

test('returns a cached zip without fetching', async () => withMockStorage(async () => {
  localStorage.setItem(CACHE_KEY, JSON.stringify({
    '22903': { lat: 38.0356, lng: -78.5034, label: 'Charlottesville, VA' },
  }))
  let called = false

  const result = await lookupZip('22903', {
    fetchImpl: () => {
      called = true
      return Promise.resolve(okResponse(ZIPPO_RICHMOND))
    },
  })

  assert.deepEqual(result, { lat: 38.0356, lng: -78.5034, label: 'Charlottesville, VA' })
  assert.equal(called, false)
}))

test('caches successful lookups', async () => withMockStorage(async () => {
  const result = await lookupZip('23230', {
    fetchImpl: () => Promise.resolve(okResponse(ZIPPO_RICHMOND)),
  })
  assert.deepEqual(result, { lat: 37.5538, lng: -77.4603, label: 'Richmond, VA' })

  const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, unknown>
  assert.deepEqual(cache['23230'], result)
}))

test('returns null when the request fails or json cannot be parsed', async () => {
  assert.equal(
    await lookupZip('23221', { fetchImpl: () => Promise.reject(new Error('network')) }),
    null
  )
  assert.equal(
    await lookupZip('23222', {
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) }),
    }),
    null
  )
})

test('returns null when coordinates are not numeric', async () => {
  const result = await lookupZip('23223', {
    fetchImpl: () => Promise.resolve(okResponse({
      places: [{ 'place name': 'Richmond', 'state abbreviation': 'VA', latitude: 'nope', longitude: '-77' }],
    })),
  })
  assert.equal(result, null)
})

test('falls back to the zip label when place name or state is absent', async () => {
  const result = await lookupZip('23224', {
    fetchImpl: () => Promise.resolve(okResponse({
      places: [{ latitude: '37.5', longitude: '-77.4' }],
    })),
  })
  assert.deepEqual(result, { lat: 37.5, lng: -77.4, label: '23224' })
})
