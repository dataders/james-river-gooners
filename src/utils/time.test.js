import test from 'node:test'
import assert from 'node:assert/strict'
import { timeRemaining } from './time.js'

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

test('timeRemaining returns Ended for past Maxanet date', () => {
  assert.equal(timeRemaining('2020-01-01 12:00:00 PM'), 'Ended')
})

test('timeRemaining returns Ended for past ISO date (HiBid format)', () => {
  assert.equal(timeRemaining('2020-01-01T12:00:00+00:00'), 'Ended')
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
