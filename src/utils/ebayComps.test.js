import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildEbaySoldSearches,
  buildEbaySoldSearchUrl,
  compactItemText,
  getEbayCompThumbnail,
  getEbayCompKey,
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
    new URL('../../public/data/ebay-comps/XgTddU43tCQrk0_gjgUuBA.json', import.meta.url),
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
