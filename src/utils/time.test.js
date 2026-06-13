import test from 'node:test'
import assert from 'node:assert/strict'
import { timeRemaining, itemTimeRemaining, itemEnded } from './time.js'

// ── missing / empty input ─────────────────────────────────────────────────────

test('timeRemaining returns empty string for null', () => {
  assert.equal(timeRemaining(null), '')
})

test('timeRemaining returns empty string for undefined', () => {
  assert.equal(timeRemaining(undefined), '')
})

test('timeRemaining returns empty string for empty string', () => {
  assert.equal(timeRemaining(''), '')
})

// ── ended dates ───────────────────────────────────────────────────────────────

test('timeRemaining returns Ended with the close date for past Maxanet date', () => {
  const result = timeRemaining('2020-01-01 12:00:00 PM')
  assert.match(result, /^Ended Jan 1, /, `expected "Ended Jan 1, …", got "${result}"`)
})

test('timeRemaining returns Ended with the close date for past ISO date (HiBid format)', () => {
  const result = timeRemaining('2020-01-01T12:00:00+00:00')
  assert.match(result, /^Ended /, `expected "Ended …", got "${result}"`)
})

// ── future dates: correct parsing (regression for NaN bug) ───────────────────

test('timeRemaining returns a valid d/h string for a far-future Maxanet date', () => {
  // Use a date years out so the test is stable regardless of when it runs
  const result = timeRemaining('2099-12-31 11:59:00 PM')
  assert.match(result, /^\d+d \d+h$/, `expected "Xd Yh", got "${result}"`)
  assert.ok(!result.includes('NaN'), 'should not contain NaN')
})

test('timeRemaining returns a valid d/h string for a far-future ISO date (HiBid format)', () => {
  const result = timeRemaining('2099-12-31T23:59:00+00:00')
  assert.match(result, /^\d+d \d+h$/, `expected "Xd Yh", got "${result}"`)
  assert.ok(!result.includes('NaN'), 'should not contain NaN')
})

test('timeRemaining returns a valid h/m string for a near-future ISO date', () => {
  // 90 minutes from now
  const soon = new Date(Date.now() + 90 * 60 * 1000).toISOString()
  const result = timeRemaining(soon)
  assert.match(result, /^\d+h \d+m$/, `expected "Xh Ym", got "${result}"`)
  assert.ok(!result.includes('NaN'), 'should not contain NaN')
})

// ── day vs hour/min boundary ──────────────────────────────────────────────────

test('timeRemaining uses Xd Yh format when more than 24 hours remain', () => {
  const future = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString()
  const result = timeRemaining(future)
  assert.match(result, /^\d+d \d+h$/)
})

test('timeRemaining uses Xh Ym format when less than 24 hours remain', () => {
  const future = new Date(Date.now() + 3 * 3600 * 1000).toISOString()
  const result = timeRemaining(future)
  assert.match(result, /^\d+h \d+m$/)
})

// ── itemTimeRemaining: auctionEndDate fallback (closed Cannon's lots) ─────────

test('itemTimeRemaining uses endDate when present', () => {
  assert.match(itemTimeRemaining({ endDate: '2020-01-01 12:00:00 PM' }), /^Ended /)
})

test('itemTimeRemaining falls back to auctionEndDate when endDate is blank', () => {
  assert.match(
    itemTimeRemaining({ endDate: '', auctionEndDate: '2020-01-01 12:00:00 PM' }),
    /^Ended /,
  )
})

test('itemTimeRemaining returns empty string when both dates are missing', () => {
  assert.equal(itemTimeRemaining({ endDate: '', auctionEndDate: '' }), '')
})

test('itemTimeRemaining handles a null/undefined item', () => {
  assert.equal(itemTimeRemaining(null), '')
  assert.equal(itemTimeRemaining(undefined), '')
})

// ── itemEnded: boolean for bid eligibility (decoupled from display string) ────

test('itemEnded is true for a past per-lot endDate', () => {
  assert.equal(itemEnded({ endDate: '2020-01-01 12:00:00 PM' }), true)
})

test('itemEnded falls back to auctionEndDate when endDate is blank', () => {
  assert.equal(itemEnded({ endDate: '', auctionEndDate: '2020-01-01 12:00:00 PM' }), true)
})

test('itemEnded is true when both dates are missing (no live deadline)', () => {
  assert.equal(itemEnded({ endDate: '', auctionEndDate: '' }), true)
  assert.equal(itemEnded(null), true)
})

test('itemEnded is false for a far-future endDate', () => {
  assert.equal(itemEnded({ endDate: '2099-12-31T23:59:00+00:00' }), false)
})
