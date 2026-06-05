import test from 'node:test'
import assert from 'node:assert/strict'
import { getDisplayEnrichment, isHighConfidence, hasEnrichment } from './enrichment.js'

test('hasEnrichment matches what the UI can actually show', () => {
  // Medium or high with a brand/model => identified.
  assert.equal(hasEnrichment({ enrichmentConfidence: 'high', brand: 'Dietz', modelOrSku: 'Lantern' }), true)
  assert.equal(hasEnrichment({ enrichmentConfidence: 'medium', brand: 'Dietz' }), true)
  // Confident but nothing to show => not identified.
  assert.equal(hasEnrichment({ enrichmentConfidence: 'high', brand: '', modelOrSku: '' }), false)
  // Below the display bar => not identified.
  assert.equal(hasEnrichment({ enrichmentConfidence: 'low', brand: 'Dietz' }), false)
  assert.equal(hasEnrichment({}), false)
})

test('isHighConfidence only true for high (case-insensitive)', () => {
  assert.equal(isHighConfidence({ enrichmentConfidence: 'high' }), true)
  assert.equal(isHighConfidence({ enrichmentConfidence: 'HIGH' }), true)
  assert.equal(isHighConfidence({ enrichmentConfidence: 'medium' }), false)
  assert.equal(isHighConfidence({ enrichmentConfidence: '' }), false)
  assert.equal(isHighConfidence({}), false)
  assert.equal(isHighConfidence(null), false)
})

test('getDisplayEnrichment returns label/condition/url for confident lots', () => {
  const out = getDisplayEnrichment({
    enrichmentConfidence: 'high',
    brand: 'Gillette',
    modelOrSku: 'Super Speed',
    condition: 'used',
    productUrl: 'https://gillette.com/super-speed',
  })
  assert.equal(out.label, 'Gillette Super Speed')
  assert.equal(out.condition, 'used')
  assert.equal(out.productUrl, 'https://gillette.com/super-speed')
})

test('getDisplayEnrichment joins whichever of brand/model is present', () => {
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: 'high', brand: 'Dietz', modelOrSku: '' }).label, 'Dietz')
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: 'high', brand: '', modelOrSku: 'DCD771' }).label, 'DCD771')
})

test('getDisplayEnrichment shows medium confidence and passes the bar through', () => {
  const out = getDisplayEnrichment({ enrichmentConfidence: 'medium', brand: 'Dietz', modelOrSku: 'Lantern' })
  assert.equal(out.label, 'Dietz Lantern')
  assert.equal(out.confidence, 'medium')
})

test('getDisplayEnrichment is null below the display bar (low/absent)', () => {
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: 'low', brand: 'Acme', modelOrSku: 'X' }), null)
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: '', brand: 'Acme', modelOrSku: 'X' }), null)
  assert.equal(getDisplayEnrichment({}), null)
})

test('getDisplayEnrichment is null when high confidence but no brand/model', () => {
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: 'high', brand: '', modelOrSku: '', condition: 'used' }), null)
})

test('getDisplayEnrichment drops a non-http productUrl', () => {
  const out = getDisplayEnrichment({ enrichmentConfidence: 'high', brand: 'Dietz', modelOrSku: 'Lantern', productUrl: 'gillette.com' })
  assert.equal(out.productUrl, '')
})
