import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAuctionDate, isPastDeadline } from './dates.js'

// ── parseAuctionDate: missing / malformed ────────────────────────────────────

test('parseAuctionDate returns null for null/undefined/empty', () => {
  assert.equal(parseAuctionDate(null), null)
  assert.equal(parseAuctionDate(undefined), null)
  assert.equal(parseAuctionDate(''), null)
})

test('parseAuctionDate returns null for an unparseable string', () => {
  assert.equal(parseAuctionDate('not a date'), null)
})

// ── parseAuctionDate: both supported formats ─────────────────────────────────

test('parseAuctionDate parses Maxanet "YYYY-MM-DD H:MM:SS AM/PM"', () => {
  const d = parseAuctionDate('2026-06-01 9:59:00 PM')
  assert.ok(d instanceof Date)
  assert.equal(d.getFullYear(), 2026)
})

test('parseAuctionDate parses ISO (HiBid) without corrupting it', () => {
  // Regression: the old replace(/-/g,'/') trick turned ISO into NaN.
  const d = parseAuctionDate('2026-06-06T23:00:00+00:00')
  assert.ok(d instanceof Date)
  assert.equal(d.getTime(), Date.parse('2026-06-06T23:00:00+00:00'))
})

// ── isPastDeadline ───────────────────────────────────────────────────────────

test('isPastDeadline is true for a past date (both formats)', () => {
  assert.equal(isPastDeadline('2020-01-01 12:00:00 PM'), true)
  assert.equal(isPastDeadline('2020-01-01T12:00:00+00:00'), true)
})

test('isPastDeadline is false for a far-future date', () => {
  assert.equal(isPastDeadline('2099-12-31 11:59:00 PM'), false)
  assert.equal(isPastDeadline('2099-12-31T23:59:00+00:00'), false)
})

test('isPastDeadline respects the provided now reference', () => {
  const end = '2026-06-01T12:00:00+00:00'
  const endMs = Date.parse(end)
  assert.equal(isPastDeadline(end, endMs - 1000), false)
  assert.equal(isPastDeadline(end, endMs + 1000), true)
  assert.equal(isPastDeadline(end, endMs), true) // boundary: at deadline counts as passed
})

test('isPastDeadline is false for missing/malformed dates (never auto-hide on bad data)', () => {
  assert.equal(isPastDeadline(null), false)
  assert.equal(isPastDeadline('garbage'), false)
})
