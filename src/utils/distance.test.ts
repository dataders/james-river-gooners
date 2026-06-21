import test from 'node:test'
import assert from 'node:assert/strict'

import { haversineMiles, RADIUS_OPTIONS, DEFAULT_LOCATION } from './distance.ts'

test('zero distance for identical points', () => {
  assert.equal(haversineMiles(37.54, -77.43, 37.54, -77.43), 0)
})

test('Richmond → Midlothian is ~12 miles', () => {
  // Richmond (37.5385, -77.4343) to Midlothian (37.5063, -77.6493)
  const d = haversineMiles(37.538509, -77.43428, 37.506267, -77.649268)
  assert.ok(d > 11 && d < 13, `expected ~12mi, got ${d}`)
})

test('Richmond → Virginia Beach is ~93 miles', () => {
  const d = haversineMiles(37.538509, -77.43428, 36.849658, -75.976075)
  assert.ok(d > 88 && d < 98, `expected ~93mi, got ${d}`)
})

test('Richmond → Charlottesville is ~65-75 miles', () => {
  const d = haversineMiles(37.538509, -77.43428, 38.029306, -78.476678)
  assert.ok(d > 60 && d < 78, `expected ~70mi, got ${d}`)
})

test('symmetric', () => {
  const a = haversineMiles(37.5, -77.4, 36.8, -76.0)
  const b = haversineMiles(36.8, -76.0, 37.5, -77.4)
  assert.equal(a, b)
})

test('RADIUS_OPTIONS includes the 25mi default and an "Any" (null) option', () => {
  const values = RADIUS_OPTIONS.map(o => o.value)
  assert.ok(values.includes(25))
  assert.ok(values.includes(null))
})

test('DEFAULT_LOCATION is Richmond, VA with coordinates', () => {
  assert.equal(DEFAULT_LOCATION.label, 'Richmond, VA')
  assert.ok(Math.abs(DEFAULT_LOCATION.lat - 37.54) < 0.1)
  assert.ok(Math.abs(DEFAULT_LOCATION.lng - -77.43) < 0.1)
})
