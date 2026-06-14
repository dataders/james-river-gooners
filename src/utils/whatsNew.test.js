// @ts-nocheck
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allChangeIds, parseSeen, serializeSeen, hasUnseenChanges } from './whatsNew.js'

const FIXTURE = [
  { date: '2026-06-05', title: 'B', changes: [{ id: 'b1' }, { id: 'b2' }] },
  { date: '2026-06-03', title: 'A', changes: [{ id: 'a1' }] },
]

test('allChangeIds lists every change id in display order', () => {
  assert.deepEqual(allChangeIds(FIXTURE), ['b1', 'b2', 'a1'])
})

test('parseSeen reads a JSON array of ids', () => {
  const seen = parseSeen(JSON.stringify(['b1', 'a1']), FIXTURE)
  assert.ok(seen.has('b1') && seen.has('a1'))
  assert.ok(!seen.has('b2'))
})

test('parseSeen treats empty/garbage as nothing seen', () => {
  assert.equal(parseSeen('', FIXTURE).size, 0)
  assert.equal(parseSeen(null, FIXTURE).size, 0)
  assert.equal(parseSeen('not json {', FIXTURE).size, 0)
})

test('parseSeen migrates a legacy date marker to all on-or-before change ids', () => {
  // Old format stamped the newest release date the user had opened the panel at.
  const seen = parseSeen('2026-06-03', FIXTURE)
  assert.ok(seen.has('a1'))            // release dated on the marker → seen
  assert.ok(!seen.has('b1'))           // newer release → still unseen
  assert.ok(!seen.has('b2'))
})

test('parseSeen legacy date on the newest release marks everything seen', () => {
  const seen = parseSeen('2026-06-05', FIXTURE)
  assert.deepEqual([...seen].sort(), ['a1', 'b1', 'b2'])
})

test('serializeSeen round-trips through parseSeen', () => {
  const ids = new Set(['b1', 'a1'])
  const seen = parseSeen(serializeSeen(ids), FIXTURE)
  assert.deepEqual([...seen].sort(), ['a1', 'b1'])
})

test('hasUnseenChanges is true while any id is unseen, false once all are seen', () => {
  assert.equal(hasUnseenChanges(new Set(['b1', 'b2']), FIXTURE), true)
  assert.equal(hasUnseenChanges(new Set(['b1', 'b2', 'a1']), FIXTURE), false)
})

test('hasUnseenChanges is true against an empty seen set', () => {
  assert.equal(hasUnseenChanges(new Set(), FIXTURE), true)
})