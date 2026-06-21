// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeLotRow,
  normalizeRowsSupabase,
} from './auctionNormalize.js'

// ── normalizeLotRow: Supabase snake_case → camelCase ─────────────────────────

test('normalizeLotRow maps core snake_case fields', () => {
  const row = {
    item_id: 'item-1',
    lot_number: 42,
    title: 'Victorian Sofa',
    description: 'Fine piece',
    current_bid: '150.00',
    total_bids: 5,
    unique_bidders: 3,
    end_date: '2026-07-01T00:00:00Z',
    images: ['https://example.com/img.jpg'],
    category: 'Furniture',
    raw_category: 'furniture',
    detail_url: 'https://example.com/lot/1',
    auction_id: 'auction-abc',
    auction_safe_id: 'abc',
    auction_title: 'Summer Sale',
    auction_end_date: '2026-07-01',
    scraped_at: '2026-06-01T00:00:00Z',
    source: 'cannons',
  }
  const item = normalizeLotRow(row)
  assert.equal(item.id, 'item-1')
  assert.equal(item.lotNumber, 42)
  assert.equal(item.currentBid, 150)
  assert.equal(item.totalBids, 5)
  assert.equal(item.uniqueBidders, 3)
  assert.equal(item.category, 'Furniture')
  assert.equal(item.auctionSafeId, 'abc')
  assert.equal(item.auctionTitle, 'Summer Sale')
})

test('normalizeLotRow coerces current_bid to Number', () => {
  assert.equal(normalizeLotRow({ current_bid: '99.50' }).currentBid, 99.5)
  assert.equal(normalizeLotRow({ current_bid: null }).currentBid, 0)
  assert.equal(normalizeLotRow({}).currentBid, 0)
})

test('normalizeLotRow includes finalBid and closed only when non-null', () => {
  const withFinal = normalizeLotRow({ final_bid: '99.50', closed: true })
  assert.equal(withFinal.finalBid, 99.5)
  assert.equal(withFinal.closed, true)

  const noFinal = normalizeLotRow({ final_bid: null })
  assert.equal('finalBid' in noFinal, false)
  assert.equal('closed' in noFinal, false)
})

test('normalizeLotRow defaults images to empty array', () => {
  assert.deepEqual(normalizeLotRow({ images: null }).images, [])
  assert.deepEqual(normalizeLotRow({}).images, [])
})

// ── normalizeRowsSupabase: builds auctions from item rows ─────────────────────
// (Supabase path has no manifest, so auction metadata comes from item rows)

test('normalizeRowsSupabase builds auction records from lot rows', () => {
  const rows = [
    { item_id: 'i1', auction_safe_id: 'a1', auction_title: 'Summer Sale',
      auction_end_date: '2026-07-01', scraped_at: '2026-06-01', source: 'cannons',
      current_bid: 100, total_bids: 2 },
    { item_id: 'i2', auction_safe_id: 'a1', auction_title: 'Summer Sale',
      auction_end_date: '2026-07-01', scraped_at: '2026-06-01', source: 'cannons',
      current_bid: 50, total_bids: 1 },
  ]
  const { auctions, items } = normalizeRowsSupabase(rows, false)
  assert.equal(auctions.length, 1)
  assert.equal(auctions[0].title, 'Summer Sale')
  assert.equal(auctions[0].totalItems, 2)
  assert.equal(items.length, 2)
})

test('normalizeRowsSupabase carries auction location for the distance filter', () => {
  const rows = [
    { item_id: 'i1', auction_safe_id: 'a1', auction_title: 'Estate',
      source: 'cannons', auction_city: 'Richmond', auction_state: 'VA',
      auction_latitude: '37.538509', auction_longitude: '-77.43428' },
  ]
  const { auctions } = normalizeRowsSupabase(rows, false)
  assert.equal(auctions[0].city, 'Richmond')
  assert.equal(auctions[0].state, 'VA')
  assert.equal(auctions[0].lat, 37.538509)
  assert.equal(auctions[0].lng, -77.43428)
})

test('normalizeRowsSupabase leaves location undefined when columns are absent', () => {
  const rows = [{ item_id: 'i1', auction_safe_id: 'a1', source: 'cannons' }]
  const { auctions } = normalizeRowsSupabase(rows, false)
  assert.equal(auctions[0].lat, undefined)
  assert.equal(auctions[0].lng, undefined)
})