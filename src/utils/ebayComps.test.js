import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildEbaySoldSearches,
  buildEbaySoldSearchUrl,
  itemExactPhrase,
  compactItemText,
  getEbayCompThumbnail,
  getEbayCompKey,
  groupSupabaseComps,
  hasEbayComps,
  isEbayItemUrl,
  normalizeEbaySoldMatches,
} from './ebayComps.js'

test('buildEbaySoldSearchUrl targets eBay sold and completed results', () => {
  const url = new URL(buildEbaySoldSearchUrl('Sony Bravia KDL-32BX300'))

  assert.equal(url.origin, 'https://www.ebay.com')
  assert.equal(url.pathname, '/sch/i.html')
  assert.equal(url.searchParams.get('_nkw'), 'Sony Bravia KDL-32BX300')
  assert.equal(url.searchParams.get('LH_Sold'), '1')
  assert.equal(url.searchParams.get('LH_Complete'), '1')
  assert.equal(url.searchParams.get('_sop'), '13')
})

test('getEbayCompKey matches auction and item ids', () => {
  assert.equal(
    getEbayCompKey({ auctionSafeId: 'abc', id: '123' }),
    'abc:123'
  )
})

test('isEbayItemUrl accepts sold item pages but rejects search pages', () => {
  assert.equal(isEbayItemUrl('https://www.ebay.com/itm/177917908706'), true)
  assert.equal(isEbayItemUrl('https://www.ebay.com/sch/i.html?_nkw=Five+sterling+silver+rimmed'), false)
})

test('normalizeEbaySoldMatches keeps only priced matches with real item links', () => {
  const matches = normalizeEbaySoldMatches({
    matches: [
      {
        title: 'Real sold item',
        price: { value: '99.00', currency: 'USD' },
        soldDateLabel: 'Sold Mar 4, 2026',
        itemWebUrl: 'https://www.ebay.com/itm/177917908706',
      },
      {
        title: 'Keyword search masquerading as a comp',
        price: { value: '55.00', currency: 'USD' },
        itemWebUrl: 'https://www.ebay.com/sch/i.html?_nkw=Five+sterling+silver+rimmed',
      },
      {
        title: 'No price',
        itemWebUrl: 'https://www.ebay.com/itm/177917908707',
      },
    ],
  })

  assert.equal(matches.length, 1)
  assert.equal(matches[0].title, 'Real sold item')
  assert.equal(matches[0].priceLabel, '$99.00')
  assert.equal(matches[0].itemWebUrl, 'https://www.ebay.com/itm/177917908706')
})

test('tester eBay comps keep sold prices and direct item links', () => {
  const fixture = JSON.parse(readFileSync(
    new URL('./__fixtures__/ebay-comps-sample.json', import.meta.url),
    'utf8'
  ))

  assert.equal(fixture.source, 'motherduck')
  assert.deepEqual(Object.keys(fixture.items).sort(), ['48996412', '48996451', '48996549'])

  for (const [itemId, soldComps] of Object.entries(fixture.items)) {
    const matches = normalizeEbaySoldMatches(soldComps)
    assert.ok(matches.length > 0, `${itemId} has at least one comp`)

    for (const match of matches) {
      assert.match(match.priceLabel, /^\$\d/)
      assert.equal(isEbayItemUrl(match.itemWebUrl), true)
    }
  }
})

test('getEbayCompThumbnail returns the comp photo and never the auction image', () => {
  const auctionItem = { images: ['https://example.com/cannons-lot.jpg'] }

  // Real eBay thumbnail is used as-is.
  assert.equal(
    getEbayCompThumbnail({ thumbnailUrl: 'https://i.ebayimg.com/x.jpg' }, auctionItem),
    'https://i.ebayimg.com/x.jpg'
  )

  // No eBay thumbnail → empty string, NOT the auction item's photo.
  assert.equal(getEbayCompThumbnail({}, auctionItem), '')
  assert.equal(getEbayCompThumbnail(null), '')
})

test('buildEbaySoldSearches keeps model-like terms for electronics', () => {
  const searches = buildEbaySoldSearches({
    title: 'Lot - 47',
    description: 'Sony Bravia TV model KDL-32BX300 with remote, includes VCR and DVD player, please preview for working condition',
    category: 'Electronics',
    rawCategory: 'Electronics',
  })

  assert.equal(searches[0].label, 'Specific match')
  assert.match(searches[0].query, /Sony Bravia/i)
  assert.match(searches[0].query, /KDL-32BX300/)
})

test('buildEbaySoldSearches handles decorative item descriptions', () => {
  const searches = buildEbaySoldSearches({
    title: 'Lot - 92',
    description: 'Lenox handcrafted porcelain vase with floral relief and gold trim; measures 12"',
    category: 'Art',
    rawCategory: 'Decorative Accessories',
  })

  assert.match(searches[0].query, /Lenox handcrafted porcelain vase/i)
  assert.equal(searches.some(search => search.query.includes('measures')), false)
})

test('buildEbaySoldSearches uses a quoted exact phrase for the specific query', () => {
  // The motivating bug: tokenized queries OR'd individual words, so a trumpet
  // matched any of fever/brand/brass/student/trumpet and returned junk.
  const searches = buildEbaySoldSearches({
    title: 'Fever Brand Brass Student Trumpet',
    description: '',
    category: 'Musical Instruments',
    rawCategory: 'Musical Instruments',
  })

  assert.equal(searches[0].kind, 'specific')
  assert.equal(searches[0].query, '"Fever Brand Brass Student Trumpet"')
  // The eBay link carries the quoted phrase through to _nkw (URLSearchParams
  // encodes the quotes as %22 and spaces as +).
  assert.match(searches[0].url, /_nkw=%22Fever\+Brand\+Brass\+Student\+Trumpet%22/)
  // Broad/category fallbacks remain available, and they are NOT quoted.
  assert.ok(searches.some(s => s.kind === 'broad' && !s.query.includes('"')))
})

test('buildEbaySoldSearches prefers the enriched searchQuery for confident lots', () => {
  // A confidently-identified lot uses the Haiku searchQuery (unquoted, so eBay
  // AND-matches the terms) instead of the lot's own title/description text.
  const searches = buildEbaySoldSearches({
    title: 'Lot - 42',
    description: 'a box of power tools, dusty',
    enrichmentConfidence: 'high',
    brand: 'DeWalt',
    modelOrSku: 'DCD771',
    searchQuery: 'DeWalt DCD771 cordless drill',
  })
  assert.equal(searches[0].kind, 'specific')
  assert.equal(searches[0].query, 'DeWalt DCD771 cordless drill')
})

test('buildEbaySoldSearches ignores searchQuery when confidence is low', () => {
  // Low/absent enrichment confidence must never override the text-derived query,
  // so junk enrichment never worsens the comp search.
  const searches = buildEbaySoldSearches({
    title: 'Pair of brass candlesticks',
    description: '',
    enrichmentConfidence: 'low',
    searchQuery: 'totally wrong guess',
  })
  assert.equal(searches[0].query, '"Pair of brass candlesticks"')
})

test('itemExactPhrase caps length, falls back to description, and skips one-word lots', () => {
  // Real title wins, capped to six words.
  assert.equal(
    itemExactPhrase({ title: 'Vintage Omega Seamaster De Ville Automatic Wristwatch' }),
    '"Vintage Omega Seamaster De Ville Automatic"'
  )
  // "Lot - N" placeholder titles fall back to the description.
  assert.equal(
    itemExactPhrase({ title: 'Lot - 12', description: 'Pair of brass candlesticks' }),
    '"Pair of brass candlesticks"'
  )
  // A single meaningful word is not a phrase — caller falls back to tokens.
  assert.equal(itemExactPhrase({ title: 'Trumpet', description: '' }), '')
})

test('restricted categories include a warning', () => {
  const searches = buildEbaySoldSearches({
    title: 'Lot - 18',
    description: 'Remington Mohawk-48, 12 gauge semi-automatic shot gun, 2 3/4" or shorter shells',
    category: 'Firearms',
    rawCategory: 'Firearms',
  })

  assert.match(searches[0].query, /Remington Mohawk-48/i)
  assert.match(searches[0].warning, /restricted categories/i)
})

test('compactItemText ignores lot-only titles', () => {
  assert.equal(compactItemText({
    title: 'Lot - 123',
    description: '',
    rawCategory: 'Jewelry',
  }), 'Jewelry')
})

test('groupSupabaseComps reshapes flat view rows into the read-model shape', () => {
  const rows = [
    {
      item_id: '1001',
      status: 'ok',
      query: 'Sony Bravia',
      search_url: 'https://www.ebay.com/sch/i.html?_nkw=Sony',
      fetched_at: '2026-06-05T00:00:00Z',
      warning: null,
      ebay_item_id: '111',
      title: 'Sony Bravia 32"',
      price_value: 149.99,
      price_currency: 'USD',
      item_web_url: 'https://www.ebay.com/itm/123456789011',
      source_query: 'specific',
      match_confidence: 'medium',
    },
    {
      item_id: '1001',
      status: 'ok',
      query: 'Sony Bravia',
      ebay_item_id: '222',
      title: 'Sony Bravia TV',
      price_value: 130,
      price_currency: 'USD',
      item_web_url: 'https://www.ebay.com/itm/123456789022',
    },
  ]

  const items = groupSupabaseComps(rows)
  assert.deepEqual(Object.keys(items), ['1001'])
  const entry = items['1001']
  assert.equal(entry.query, 'Sony Bravia')
  assert.equal(entry.searchUrl, 'https://www.ebay.com/sch/i.html?_nkw=Sony')
  assert.equal(entry.matches.length, 2)
  assert.deepEqual(entry.matches[0].price, { value: 149.99, currency: 'USD' })

  // The reshaped entry must be consumable by the same readers the static
  // read model feeds.
  assert.equal(hasEbayComps(entry), true)
  const normalized = normalizeEbaySoldMatches(entry)
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].priceLabel, '$149.99')
})

test('groupSupabaseComps skips rows without an item id and handles empties', () => {
  assert.deepEqual(groupSupabaseComps([]), {})
  assert.deepEqual(groupSupabaseComps(undefined), {})
  assert.deepEqual(groupSupabaseComps([{ title: 'orphan' }]), {})
})
