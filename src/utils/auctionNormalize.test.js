import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRowsNdjson,
  normalizeLotRow,
  normalizeRowsSupabase,
} from './auctionNormalize.js'

// ── normalizeRowsNdjson: manifest-first contract ──────────────────────────────

test('normalizeRowsNdjson prefers manifest fields over item-row fields', () => {
  const entries = [{
    safeId: 'abc',
    title: 'Manifest Title',
    endDate: '2026-07-01T00:00:00Z',
    scrapedAt: '2026-06-15T00:00:00Z',
    source: 'hibid',
  }]
  const rows = [{
    auctionSafeId: 'abc',
    id: 'item1',
    auctionId: 'old-id',
    auctionTitle: 'Row Title',
    auctionEndDate: '2026-06-01T00:00:00Z',
    scrapedAt: '2026-05-01T00:00:00Z',
    source: 'cannons',
  }]
  const { auctions } = normalizeRowsNdjson([rows], entries, false)
  assert.equal(auctions.length, 1)
  assert.equal(auctions[0].title, 'Manifest Title')
  assert.equal(auctions[0].endDate, '2026-07-01T00:00:00Z')
  assert.equal(auctions[0].scrapedAt, '2026-06-15T00:00:00Z')
  assert.equal(auctions[0].source, 'hibid')
})

test('normalizeRowsNdjson falls back to item-row fields when manifest entry is absent', () => {
  const entries = []
  const rows = [{
    auctionSafeId: 'xyz',
    id: 'item1',
    auctionTitle: 'Row Title',
    auctionEndDate: '2026-06-01T00:00:00Z',
    source: 'rasmus',
  }]
  const { auctions } = normalizeRowsNdjson([rows], entries, false)
  assert.equal(auctions[0].title, 'Row Title')
  assert.equal(auctions[0].source, 'rasmus')
})

test('normalizeRowsNdjson counts totalItems per auction', () => {
  const entries = [{ safeId: 'auction1', title: 'Test', source: 'cannons' }]
  const rows = [
    { auctionSafeId: 'auction1', id: 'i1' },
    { auctionSafeId: 'auction1', id: 'i2' },
    { auctionSafeId: 'auction1', id: 'i3' },
  ]
  const { auctions } = normalizeRowsNdjson([rows], entries, false)
  assert.equal(auctions[0].totalItems, 3)
})

test('normalizeRowsNdjson handles multiple auctions from multiple ndjson files', () => {
  const entries = [
    { safeId: 'a1', title: 'Auction One', source: 'cannons' },
    { safeId: 'a2', title: 'Auction Two', source: 'hibid' },
  ]
  const file1 = [{ auctionSafeId: 'a1', id: 'i1' }, { auctionSafeId: 'a1', id: 'i2' }]
  const file2 = [{ auctionSafeId: 'a2', id: 'i3' }]
  const { auctions, items } = normalizeRowsNdjson([file1, file2], entries, false)
  assert.equal(auctions.length, 2)
  assert.equal(items.length, 3)
  const a1 = auctions.find(a => a.safeId === 'a1')
  assert.equal(a1.totalItems, 2)
  assert.equal(a1.title, 'Auction One')
})

test('normalizeRowsNdjson stamps archived on every item', () => {
  const rows = [{ auctionSafeId: 'a1', id: 'i1' }]
  const { items } = normalizeRowsNdjson([rows], [], true)
  assert.equal(items[0].archived, true)
})

test('normalizeRowsNdjson silently skips rows with no auctionSafeId', () => {
  const rows = [
    { id: 'no-sid' },
    { auctionSafeId: 'a1', id: 'has-sid' },
  ]
  const { auctions, items } = normalizeRowsNdjson([rows], [], false)
  assert.equal(items.length, 2)
  assert.equal(auctions.length, 1)
})

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
