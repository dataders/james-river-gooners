// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchAuctionComps } from './compsLoader.js'

function makeClient(pages) {
  // pages: array of row arrays, one per .range() call
  let call = 0
  return {
    from() {
      return {
        select() { return this },
        eq() { return this },
        range() {
          const data = pages[call++] ?? []
          return Promise.resolve({ data, error: null })
        },
      }
    },
  }
}

function makeErrorClient(message) {
  return {
    from() {
      return {
        select() { return this },
        eq() { return this },
        range() {
          return Promise.resolve({ data: null, error: new Error(message) })
        },
      }
    },
  }
}

test('fetchAuctionComps returns empty items on error', async () => {
  const result = await fetchAuctionComps('a1', makeErrorClient('DB error'))
  assert.equal(result.id, 'a1')
  assert.deepEqual(result.items, {})
})

test('fetchAuctionComps returns empty items when no rows', async () => {
  const result = await fetchAuctionComps('a1', makeClient([[]]))
  assert.equal(result.id, 'a1')
  assert.deepEqual(result.items, {})
})

test('fetchAuctionComps groups rows by item_id', async () => {
  const rows = [
    {
      item_id: 'i1', status: 'ok', query: 'sofa', search_url: 'https://ebay.com/x',
      fetched_at: '2026-01-01', warning: null,
      ebay_item_id: 'e1', title: 'Sofa', price_value: 100, price_currency: 'USD',
      shipping_label: null, sold_date: '2026-01-01', sold_date_label: 'Jan 1',
      thumbnail_url: null, item_web_url: 'https://ebay.com/i/e1',
      condition: 'Used', source_query: null, match_confidence: null,
    },
  ]
  const result = await fetchAuctionComps('a1', makeClient([rows]))
  assert.ok(result.items['i1'])
  assert.equal(result.items['i1'].query, 'sofa')
  assert.equal(result.items['i1'].matches.length, 1)
  assert.equal(result.items['i1'].matches[0].title, 'Sofa')
})

test('fetchAuctionComps pages until fewer than PAGE_SIZE rows returned', async () => {
  // Simulate first page full (1000 rows), second page partial
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({
    item_id: `i${i}`, status: 'ok', query: 'q', search_url: '', fetched_at: '',
    warning: null, ebay_item_id: null, title: '', price_value: 0, price_currency: 'USD',
    shipping_label: null, sold_date: null, sold_date_label: null, thumbnail_url: null,
    item_web_url: '', condition: null, source_query: null, match_confidence: null,
  }))
  const partialPage = [
    {
      item_id: 'iX', status: 'ok', query: 'q', search_url: '', fetched_at: '',
      warning: null, ebay_item_id: null, title: 'Last', price_value: 0, price_currency: 'USD',
      shipping_label: null, sold_date: null, sold_date_label: null, thumbnail_url: null,
      item_web_url: '', condition: null, source_query: null, match_confidence: null,
    },
  ]
  const result = await fetchAuctionComps('a1', makeClient([fullPage, partialPage]))
  assert.ok(result.items['i0'])
  assert.ok(result.items['iX'])
})

test('fetchAuctionComps passes auction id to eq filter', async () => {
  const seenIds = []
  const client = {
    from() {
      return {
        select() { return this },
        eq(col, val) { seenIds.push(val); return this },
        range() { return Promise.resolve({ data: [], error: null }) },
      }
    },
  }
  await fetchAuctionComps('auction-42', client)
  assert.ok(seenIds.includes('auction-42'))
})