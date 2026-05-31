/**
 * Design consistency tests — computed-style assertions that catch regressions
 * in the typography/color hierarchy introduced in the nav-ux-color-hierarchy
 * refactor. Each test checks a relative or structural invariant (e.g. "the
 * current bid is larger than the bid count") rather than exact pixel values
 * so that future theme tweaks don't require updating the suite.
 */
import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

// Helper: read one or more computed style properties from the first matching element
async function cs(page, selector, ...props) {
  return page.locator(selector).first().evaluate(
    (el, ps) => ps.map(p => getComputedStyle(el)[p]),
    props
  )
}

function px(value) { return parseFloat(value) }

test.describe('Design consistency — item card price hierarchy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('current bid is at least 1rem (16 px)', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    const [fontSize] = await cs(page, '.item-bid', 'fontSize')
    expect(px(fontSize)).toBeGreaterThanOrEqual(16)
  })

  test('current bid has font-weight >= 700', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    const [weight] = await cs(page, '.item-bid', 'fontWeight')
    expect(px(weight)).toBeGreaterThanOrEqual(700)
  })

  test('current bid is visually larger than the bid count', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    const [bidSize, bidsSize] = await page.locator('.item-card').first().evaluate(el => {
      const bid = el.querySelector('.item-bid')
      const bids = el.querySelector('.item-bids')
      return [
        parseFloat(getComputedStyle(bid).fontSize),
        parseFloat(getComputedStyle(bids).fontSize),
      ]
    })
    expect(bidSize).toBeGreaterThan(bidsSize)
  })

  test('item-roi-row has a visible top border that separates it from the price', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const roiCount = await page.locator('.item-roi-row').count()
    test.skip(roiCount === 0, 'no items have eBay comp data')
    const [borderWidth, borderStyle] = await cs(page, '.item-roi-row', 'borderTopWidth', 'borderTopStyle')
    expect(borderStyle).not.toBe('none')
    expect(px(borderWidth)).toBeGreaterThan(0)
  })

  test('roi label text is smaller than the current bid', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const roiCount = await page.locator('.item-roi-row').count()
    test.skip(roiCount === 0, 'no items have eBay comp data')
    const [bidSize, labelSize] = await page.locator('.item-card:has(.item-roi-row)').first().evaluate(el => [
      parseFloat(getComputedStyle(el.querySelector('.item-bid')).fontSize),
      parseFloat(getComputedStyle(el.querySelector('.item-roi-label')).fontSize),
    ])
    expect(labelSize).toBeLessThan(bidSize)
  })

  test('roi label has lower font-weight than the current bid', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const roiCount = await page.locator('.item-roi-row').count()
    test.skip(roiCount === 0, 'no items have eBay comp data')
    const [bidWeight, labelWeight] = await page.locator('.item-card:has(.item-roi-row)').first().evaluate(el => [
      parseFloat(getComputedStyle(el.querySelector('.item-bid')).fontWeight),
      parseFloat(getComputedStyle(el.querySelector('.item-roi-label')).fontWeight),
    ])
    expect(labelWeight).toBeLessThanOrEqual(bidWeight)
  })
})

test.describe('Design consistency — detail panel price hierarchy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('detail panel has a visible "Current bid" caption label', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const label = page.locator('.detail-price-label')
    await expect(label).toBeVisible()
    await expect(label).toContainText(/current bid/i)
  })

  test('detail panel caption label is above the bid price in the DOM', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const [labelY, bidY] = await page.locator('.detail-panel').evaluate(el => [
      el.querySelector('.detail-price-label').getBoundingClientRect().top,
      el.querySelector('.detail-bid').getBoundingClientRect().top,
    ])
    expect(labelY).toBeLessThan(bidY)
  })

  test('detail bid is at least 1.5rem (24 px)', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const [fontSize] = await cs(page, '.detail-bid', 'fontSize')
    expect(px(fontSize)).toBeGreaterThanOrEqual(24)
  })

  test('detail bid has font-weight >= 700', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const [weight] = await cs(page, '.detail-bid', 'fontWeight')
    expect(px(weight)).toBeGreaterThanOrEqual(700)
  })

  test('detail bid is visually larger than the detail bid count', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const [bidSize, bidsSize] = await page.locator('.detail-panel').evaluate(el => [
      parseFloat(getComputedStyle(el.querySelector('.detail-bid')).fontSize),
      parseFloat(getComputedStyle(el.querySelector('.detail-bids')).fontSize),
    ])
    expect(bidSize).toBeGreaterThan(bidsSize)
  })

  test('detail bid is larger than any item-card bid on the grid', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    const [cardBidSize] = await cs(page, '.item-bid', 'fontSize')
    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    const [detailBidSize] = await cs(page, '.detail-bid', 'fontSize')
    expect(px(detailBidSize)).toBeGreaterThan(px(cardBidSize))
  })
})

test.describe('Design consistency — ROI calculator hierarchy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('max bid result block carries the --primary modifier class', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'no items with comp data')
    await cards.first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    await expect(page.locator('.roi-result-block--primary')).toBeVisible()
  })

  test('max bid block has a different border color than the cost block', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'no items with comp data')
    await cards.first().click()
    await expect(page.locator('.roi-calc')).toBeVisible()
    const [primaryBorder, costBorder] = await page.locator('.roi-result-block').evaluateAll(els =>
      els.map(el => getComputedStyle(el).borderTopColor)
    )
    expect(primaryBorder).not.toBe(costBorder)
  })

  test('max bid result value is at least 1.25rem (20 px)', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'no items with comp data')
    await cards.first().click()
    await expect(page.locator('.roi-calc')).toBeVisible()
    const [fontSize] = await cs(page, '.roi-result-value', 'fontSize')
    expect(px(fontSize)).toBeGreaterThanOrEqual(20)
  })

  test('cost result value is smaller than max bid result value', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'no items loaded')
    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'no items with comp data')
    await cards.first().click()
    await expect(page.locator('.roi-calc')).toBeVisible()
    const [maxSize, costSize] = await page.locator('.roi-results').evaluate(el => {
      const values = el.querySelectorAll('.roi-result-value')
      return Array.from(values).map(v => parseFloat(getComputedStyle(v).fontSize))
    })
    expect(costSize).toBeLessThanOrEqual(maxSize)
  })
})

test.describe('Design consistency — navigation active-state hierarchy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('inactive deals-toggle has a different text color than when active', async ({ page }) => {
    const btn = page.locator('button.deals-toggle').first()
    const inactiveColor = await btn.evaluate(el => getComputedStyle(el).color)
    await btn.click()
    await expect(btn).toHaveClass(/active/)
    const activeColor = await btn.evaluate(el => getComputedStyle(el).color)
    expect(activeColor).not.toBe(inactiveColor)
  })

  test('active deals-toggle has higher font-weight than inactive', async ({ page }) => {
    const btn = page.locator('button.deals-toggle').first()
    const inactiveWeight = await btn.evaluate(el => parseFloat(getComputedStyle(el).fontWeight))
    await btn.click()
    await expect(btn).toHaveClass(/active/)
    const activeWeight = await btn.evaluate(el => parseFloat(getComputedStyle(el).fontWeight))
    expect(activeWeight).toBeGreaterThan(inactiveWeight)
  })
})

test.describe('Design consistency — range filter label hierarchy', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('range filter label has font-weight <= 600 (subordinate to the value)', async ({ page }) => {
    const [weight] = await cs(page, '.range-label', 'fontWeight')
    expect(px(weight)).toBeLessThanOrEqual(600)
  })

  test('range value has font-weight >= 700 (primary data)', async ({ page }) => {
    const [weight] = await cs(page, '.range-value', 'fontWeight')
    expect(px(weight)).toBeGreaterThanOrEqual(700)
  })

  test('range value font-size is at least as large as the label font-size', async ({ page }) => {
    const [labelSize, valueSize] = await page.locator('.range-label').first().evaluate(el => [
      parseFloat(getComputedStyle(el).fontSize),
      parseFloat(getComputedStyle(el.querySelector('.range-value')).fontSize),
    ])
    expect(valueSize).toBeGreaterThanOrEqual(labelSize)
  })

  test('range label font-weight is lower than range value font-weight', async ({ page }) => {
    const [labelWeight, valueWeight] = await page.locator('.range-label').first().evaluate(el => [
      parseFloat(getComputedStyle(el).fontWeight),
      parseFloat(getComputedStyle(el.querySelector('.range-value')).fontWeight),
    ])
    expect(labelWeight).toBeLessThan(valueWeight)
  })
})
