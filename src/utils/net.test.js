import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchWithRetry, fetchJsonWithRetry } from './net.js'

function response(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (typeof body === 'string' ? JSON.parse(body || '{}') : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

// A fetch stub that returns the next queued result on each call.
function stubFetch(results) {
  let i = 0
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const r = results[Math.min(i, results.length - 1)]
    i++
    if (r instanceof Error) throw r
    return r
  }
  impl.callCount = () => i
  impl.calls = calls
  return impl
}

const fast = { baseDelayMs: 1 }

test('returns immediately on a 2xx response', async () => {
  const impl = stubFetch([response(200, '{"ok":true}')])
  const resp = await fetchWithRetry('u', { ...fast, fetchImpl: impl })
  assert.equal(resp.status, 200)
  assert.equal(impl.callCount(), 1)
})

test('does not retry on a 4xx response', async () => {
  const impl = stubFetch([response(404)])
  const resp = await fetchWithRetry('u', { ...fast, fetchImpl: impl })
  assert.equal(resp.status, 404)
  assert.equal(impl.callCount(), 1)
})

test('retries on 5xx then succeeds', async () => {
  const impl = stubFetch([response(503), response(500), response(200, '{}')])
  const resp = await fetchWithRetry('u', { ...fast, retries: 3, fetchImpl: impl })
  assert.equal(resp.status, 200)
  assert.equal(impl.callCount(), 3)
})

test('returns the last 5xx after exhausting retries', async () => {
  const impl = stubFetch([response(500)])
  const resp = await fetchWithRetry('u', { ...fast, retries: 2, fetchImpl: impl })
  assert.equal(resp.status, 500)
  assert.equal(impl.callCount(), 3) // initial + 2 retries
})

test('retries on network error then succeeds', async () => {
  const impl = stubFetch([new TypeError('network'), response(200, '{}')])
  const resp = await fetchWithRetry('u', { ...fast, retries: 2, fetchImpl: impl })
  assert.equal(resp.status, 200)
  assert.equal(impl.callCount(), 2)
})

test('throws the network error after exhausting retries', async () => {
  const impl = stubFetch([new TypeError('boom')])
  await assert.rejects(
    fetchWithRetry('u', { ...fast, retries: 1, fetchImpl: impl }),
    /boom/,
  )
  assert.equal(impl.callCount(), 2)
})

test('fetchJsonWithRetry parses a successful body', async () => {
  const impl = stubFetch([response(200, '{"value":42}')])
  const data = await fetchJsonWithRetry('u', { ...fast, fetchImpl: impl })
  assert.deepEqual(data, { value: 42 })
})

test('fetchJsonWithRetry throws on a non-ok response', async () => {
  const impl = stubFetch([response(404)])
  await assert.rejects(
    fetchJsonWithRetry('u', { ...fast, fetchImpl: impl }),
    /404/,
  )
})
