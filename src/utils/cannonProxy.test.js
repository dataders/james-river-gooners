import test from 'node:test'
import assert from 'node:assert/strict'
import { callProxy } from './cannonProxy.js'

function makeClient({ session = null, invokeResult = {} } = {}) {
  return {
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
    },
    functions: {
      invoke: () => Promise.resolve(invokeResult),
    },
  }
}

test('callProxy returns error when client is null', async () => {
  const result = await callProxy('get_status', {}, null)
  assert.equal(result.error, 'Not configured')
})

test('callProxy returns error when client is undefined', async () => {
  const result = await callProxy('get_status', {}, undefined)
  assert.equal(result.error, 'Not configured')
})

test('callProxy returns error when no session', async () => {
  const result = await callProxy('get_status', {}, makeClient({ session: null }))
  assert.equal(result.error, 'Not signed in')
})

test('callProxy returns data on success', async () => {
  const client = makeClient({
    session: { access_token: 'tok' },
    invokeResult: { data: { linked: true, username: 'alice' }, error: null },
  })
  const result = await callProxy('get_status', {}, client)
  assert.equal(result.linked, true)
  assert.equal(result.username, 'alice')
})

test('callProxy returns empty object when data is null', async () => {
  const client = makeClient({
    session: { access_token: 'tok' },
    invokeResult: { data: null, error: null },
  })
  const result = await callProxy('get_status', {}, client)
  assert.deepEqual(result, {})
})

test('callProxy extracts structured error from FunctionsHttpError', async () => {
  const client = makeClient({
    session: { access_token: 'tok' },
    invokeResult: {
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          json: () => Promise.resolve({ error: 'Invalid credentials' }),
        },
      },
    },
  })
  const result = await callProxy('save_credentials', {}, client)
  assert.equal(result.error, 'Invalid credentials')
})

test('callProxy falls back to error.message when json parse fails', async () => {
  const client = makeClient({
    session: { access_token: 'tok' },
    invokeResult: {
      data: null,
      error: {
        message: 'Network error',
        context: {
          json: () => Promise.reject(new Error('not JSON')),
        },
      },
    },
  })
  const result = await callProxy('get_bids', {}, client)
  assert.equal(result.error, 'Network error')
})

test('callProxy falls back to error.message when no context', async () => {
  const client = makeClient({
    session: { access_token: 'tok' },
    invokeResult: { data: null, error: { message: 'Timeout' } },
  })
  const result = await callProxy('get_bids', {}, client)
  assert.equal(result.error, 'Timeout')
})

test('callProxy passes action and params in the request body', async () => {
  let capturedBody = null
  const client = {
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) },
    functions: {
      invoke: (_fn, opts) => {
        capturedBody = opts.body
        return Promise.resolve({ data: {}, error: null })
      },
    },
  }
  await callProxy('save_credentials', { username: 'bob', password: 'secret' }, client)
  assert.equal(capturedBody.action, 'save_credentials')
  assert.equal(capturedBody.username, 'bob')
  assert.equal(capturedBody.password, 'secret')
})
