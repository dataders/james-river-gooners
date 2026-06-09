import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllRows, PAGE_SIZE } from './supabasePaging.ts'

// A stub PageFetcher serving `pages` in order; a missing page yields []. Records
// the (from, to) windows it was asked for so we can assert sequential paging.
function makeFetcher(pages: unknown[][], ranges?: Array<[number, number]>) {
  let call = 0
  return (from: number, to: number) => {
    if (ranges) ranges.push([from, to])
    const data = pages[call++] ?? []
    return Promise.resolve({ data, error: null })
  }
}

test('fetchAllRows returns a single short page as-is', async () => {
  const rows = await fetchAllRows(makeFetcher([[{ a: 1 }, { a: 2 }]]))
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }])
})

test('fetchAllRows returns [] when the first page is empty', async () => {
  const rows = await fetchAllRows(makeFetcher([[]]))
  assert.deepEqual(rows, [])
})

test('fetchAllRows pages until a page shorter than PAGE_SIZE', async () => {
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ i }))
  const rows = await fetchAllRows(makeFetcher([full, [{ last: true }]]))
  assert.equal(rows.length, PAGE_SIZE + 1)
  assert.deepEqual(rows[PAGE_SIZE], { last: true })
})

test('fetchAllRows requests sequential PAGE_SIZE windows', async () => {
  const ranges: Array<[number, number]> = []
  const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ i }))
  await fetchAllRows(makeFetcher([full, []], ranges))
  assert.deepEqual(ranges[0], [0, PAGE_SIZE - 1])
  assert.deepEqual(ranges[1], [PAGE_SIZE, 2 * PAGE_SIZE - 1])
})

test('fetchAllRows throws when a page returns an error', async () => {
  await assert.rejects(
    () => fetchAllRows(() => Promise.resolve({ data: null, error: new Error('boom') })),
    /boom/,
  )
})

test('fetchAllRows treats null data as the end of pagination', async () => {
  const rows = await fetchAllRows(() => Promise.resolve({ data: null, error: null }))
  assert.deepEqual(rows, [])
})
