// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDisplayEnrichment,
  detailLabel,
  isHighConfidence,
  hasEnrichment,
  mapEnrichmentRow,
  groupEnrichmentRows,
  overlayEnrichment,
} from './enrichment.js'

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

test('getDisplayEnrichment is null when high confidence but no brand/model and no detail', () => {
  assert.equal(getDisplayEnrichment({ enrichmentConfidence: 'high', brand: '', modelOrSku: '', condition: 'used' }), null)
})

test('detailLabel composes the bag values in order, capitalized', () => {
  assert.equal(
    detailLabel({ details: '{"style":"mid-century modern","material":"walnut","form":"credenza"}' }),
    'Mid-century modern walnut credenza',
  )
  assert.equal(detailLabel({ details: '' }), '')
  assert.equal(detailLabel({ details: 'not json' }), '')
  assert.equal(detailLabel({}), '')
})

test('getDisplayEnrichment falls back to the detail descriptor for unbranded lots', () => {
  // An antique with no brand/model but a confident detail bag is now surfaced.
  const out = getDisplayEnrichment({
    enrichmentConfidence: 'high', brand: '', modelOrSku: '',
    detailCategory: 'art',
    details: '{"artist":"Helen Lord","medium":"watercolor","subject":"winter landscape"}',
  })
  assert.equal(out.label, 'Helen Lord watercolor winter landscape')
  assert.equal(hasEnrichment({
    enrichmentConfidence: 'high', brand: '', modelOrSku: '',
    details: '{"style":"mid-century modern","material":"walnut"}',
  }), true)
})

test('getDisplayEnrichment drops a non-http productUrl', () => {
  const out = getDisplayEnrichment({ enrichmentConfidence: 'high', brand: 'Dietz', modelOrSku: 'Lantern', productUrl: 'gillette.com' })
  assert.equal(out.productUrl, '')
})

test('getDisplayEnrichment parses the v4/v5 lot-economics fields', () => {
  const out = getDisplayEnrichment({
    enrichmentConfidence: 'high',
    brand: 'DeWalt',
    modelOrSku: 'DCD771',
    productType: 'drill',
    searchQuery: 'DeWalt DCD771 cordless drill',
    quantity: '3',
    isMixedLot: 'true',
    conditionFlags: '["untested","missing parts"]',
    keyAttributes: '["20V","brushless"]',
    secondaryItems: '[{"brand":"Milwaukee","modelOrSku":"M18","productType":"impact driver","searchQuery":"Milwaukee M18 impact driver"}]',
  })
  assert.equal(out.productType, 'drill')
  assert.equal(out.searchQuery, 'DeWalt DCD771 cordless drill')
  assert.equal(out.quantity, '3')
  assert.equal(out.isMixedLot, true)
  assert.deepEqual(out.conditionFlags, ['untested', 'missing parts'])
  assert.deepEqual(out.keyAttributes, ['20V', 'brushless'])
  assert.equal(out.secondaryItems.length, 1)
  assert.equal(out.secondaryItems[0].label, 'Milwaukee M18')
  assert.equal(out.secondaryItems[0].searchQuery, 'Milwaukee M18 impact driver')
})

test('getDisplayEnrichment yields empty lists/false for absent v4/v5 fields', () => {
  const out = getDisplayEnrichment({ enrichmentConfidence: 'high', brand: 'Dietz', modelOrSku: 'Lantern' })
  assert.equal(out.isMixedLot, false)
  assert.equal(out.quantity, '')
  assert.deepEqual(out.conditionFlags, [])
  assert.deepEqual(out.keyAttributes, [])
  assert.deepEqual(out.secondaryItems, [])
})

test('secondaryItems falls back to productType label and drops empty entries', () => {
  const out = getDisplayEnrichment({
    enrichmentConfidence: 'high',
    brand: 'Sony',
    modelOrSku: 'WH-1000XM4',
    secondaryItems: '[{"productType":"tripod","searchQuery":"camera tripod"},{"brand":"","modelOrSku":"","productType":""}]',
  })
  assert.equal(out.secondaryItems.length, 1)
  assert.equal(out.secondaryItems[0].label, 'tripod')
})

test('mapEnrichmentRow maps snake_case view columns to the item shape', () => {
  const out = mapEnrichmentRow({
    item_id: '5',
    brand: 'Delta',
    model_or_sku: '36-220C',
    condition: 'used',
    product_url: 'https://delta.com/36-220c',
    confidence: 'high',
    model: 'gpt-5.6-luna',
  })
  assert.deepEqual(out, {
    brand: 'Delta',
    modelOrSku: '36-220C',
    productType: '',
    searchQuery: '',
    condition: 'used',
    productUrl: 'https://delta.com/36-220c',
    quantity: '',
    isMixedLot: '',
    conditionFlags: '',
    keyAttributes: '',
    secondaryItems: '',
    detailCategory: '',
    details: '',
    detailConfidence: '',
    enrichmentConfidence: 'high',
    enrichmentModel: 'gpt-5.6-luna',
  })
  // The mapped shape feeds getDisplayEnrichment unchanged.
  assert.equal(getDisplayEnrichment(out).label, 'Delta 36-220C')
})

test('mapEnrichmentRow fills missing columns with empty strings', () => {
  assert.deepEqual(mapEnrichmentRow({ item_id: '1', brand: 'Giant' }), {
    brand: 'Giant', modelOrSku: '', productType: '', searchQuery: '',
    condition: '', productUrl: '', quantity: '', isMixedLot: '',
    conditionFlags: '', keyAttributes: '', secondaryItems: '',
    detailCategory: '', details: '', detailConfidence: '',
    enrichmentConfidence: '', enrichmentModel: '',
  })
})

test('mapEnrichmentRow maps the v4/v5 lot-economics + resale-risk columns', () => {
  const out = mapEnrichmentRow({
    item_id: '7',
    brand: 'DeWalt',
    product_type: 'drill',
    search_query: 'DeWalt DCD771 cordless drill',
    quantity: '3',
    is_mixed_lot: 'false',
    condition_flags: '["untested"]',
    key_attributes: '["20V","brushless"]',
    secondary_items: '[{"brand":"Milwaukee","modelOrSku":"M18","productType":"impact driver","searchQuery":"Milwaukee M18 impact driver"}]',
    confidence: 'high',
  })
  assert.equal(out.productType, 'drill')
  assert.equal(out.searchQuery, 'DeWalt DCD771 cordless drill')
  assert.equal(out.quantity, '3')
  assert.equal(out.isMixedLot, 'false')
  assert.equal(out.conditionFlags, '["untested"]')
  assert.equal(out.keyAttributes, '["20V","brushless"]')
})

test('mapEnrichmentRow maps the v6 detail columns', () => {
  const out = mapEnrichmentRow({
    item_id: '9',
    detail_category: 'art',
    details: '{"artist":"Helen Lord","medium":"watercolor"}',
    detail_confidence: 'high',
    confidence: 'high',
  })
  assert.equal(out.detailCategory, 'art')
  assert.equal(out.details, '{"artist":"Helen Lord","medium":"watercolor"}')
  assert.equal(out.detailConfidence, 'high')
})

test('groupEnrichmentRows keys by stringified item id and skips id-less rows', () => {
  const byItem = groupEnrichmentRows([
    { item_id: 1, brand: 'Genesis', confidence: 'medium' },
    { item_id: '2', brand: 'Giant', confidence: 'medium' },
    { brand: 'NoId' },
    null,
  ])
  assert.deepEqual(Object.keys(byItem), ['1', '2'])
  assert.equal(byItem['1'].brand, 'Genesis')
})

test('overlayEnrichment applies backend fields by (auctionSafeId, id)', () => {
  const items = [
    { auctionSafeId: 'a', id: 1, brand: 'old', enrichmentConfidence: 'low' },
    { auctionSafeId: 'a', id: 2, brand: 'keep' },
  ]
  const byAuction = { a: { 1: { brand: 'Delta', enrichmentConfidence: 'high' } } }
  const out = overlayEnrichment(items, byAuction)
  assert.equal(out[0].brand, 'Delta')
  assert.equal(out[0].enrichmentConfidence, 'high')
  // Item without a backend row is untouched (NDJSON fallback) — same reference.
  assert.equal(out[1], items[1])
  assert.equal(out[1].brand, 'keep')
})

test('overlayEnrichment returns the original array when nothing overlays', () => {
  const items = [{ auctionSafeId: 'a', id: 1, brand: 'keep' }]
  // Empty map (Supabase unconfigured / no rows) => identical reference, no churn.
  assert.equal(overlayEnrichment(items, {}), items)
  assert.equal(overlayEnrichment(items, { b: { 9: { brand: 'x' } } }), items)
})
