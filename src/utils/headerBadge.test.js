import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerBadge } from './headerBadge.js'

test('bid alerts take priority and show a count', () => {
  assert.deepEqual(headerBadge(3, true), { kind: 'count', value: '3' })
})

test('counts above 9 clamp to 9+', () => {
  assert.deepEqual(headerBadge(12, false), { kind: 'count', value: '9+' })
})

test('falls back to the unseen dot when no bid alerts', () => {
  assert.deepEqual(headerBadge(0, true), { kind: 'dot', value: '' })
})

test('nothing when no alerts and nothing unseen', () => {
  assert.deepEqual(headerBadge(0, false), { kind: 'none', value: '' })
})

test('treats missing/negative counts as zero', () => {
  assert.deepEqual(headerBadge(undefined, true), { kind: 'dot', value: '' })
  assert.deepEqual(headerBadge(-2, false), { kind: 'none', value: '' })
})
