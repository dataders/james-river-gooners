import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount, setRangeValue, getRangeSummary, selectEndsWithin } from './helpers.js'

// Range filters are located by label, not index: the Bidders slider renders
// only when the visible lots carry bidder data, so positional indices shift.
const PRICE = 'Price'
const BIDS = 'Bids'

// Slider positions: 0 = minimum, 200 = maximum (SLIDER_STEPS constant in the component)
const MIN_POS = 0

test.describe('Range filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('range filters section renders after data loads', async ({ page }) => {
    await expect(page.locator('.range-filters')).toBeVisible()
  })

  test('the core sliders are present (Price, Bids, Ends within)', async ({ page }) => {
    const labels = page.locator('.range-filter .range-label')
    await expect(labels.filter({ hasText: 'Price' })).toHaveCount(1)
    // "Bids" must not also match the "Bidders" label.
    await expect(labels.filter({ hasText: /^Bids/ })).toHaveCount(1)
    await expect(labels.filter({ hasText: 'Ends within' })).toHaveCount(1)
  })

  test('all summaries start as "Any" before any interaction', async ({ page }) => {
    const summaries = page.locator('.range-value')
    const count = await summaries.count()
    for (let i = 0; i < count; i++) {
      await expect(summaries.nth(i)).toHaveText('Any')
    }
  })

  test('moving price hi slider left changes summary from "Any" to "≤ X"', async ({ page }) => {
    // Set hi to half-way — filters out higher-priced items
    await setRangeValue(page, PRICE, '.range-slider-hi', 100)
    await page.waitForTimeout(200)
    const summary = await getRangeSummary(page, PRICE)
    expect(summary).not.toBe('Any')
    expect(summary).toMatch(/^≤/)
  })

  test('moving price lo slider right changes summary from "Any" to "≥ X"', async ({ page }) => {
    await setRangeValue(page, PRICE, '.range-slider-lo', 100)
    await page.waitForTimeout(200)
    const summary = await getRangeSummary(page, PRICE)
    expect(summary).not.toBe('Any')
    expect(summary).toMatch(/^≥/)
  })

  test('setting both price sliders shows a "X – Y" range summary', async ({ page }) => {
    await setRangeValue(page, PRICE, '.range-slider-lo', 50)
    await setRangeValue(page, PRICE, '.range-slider-hi', 150)
    await page.waitForTimeout(200)
    const summary = await getRangeSummary(page, PRICE)
    expect(summary).toMatch(/–/)
  })

  test('raising minimum bids filter reduces visible item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    // Position 150 on the log-scale bids slider filters out items with few bids
    await setRangeValue(page, BIDS, '.range-slider-lo', 150)
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBeLessThan(totalBefore)
  })

  test('resetting bids filter restores original count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    await setRangeValue(page, BIDS, '.range-slider-lo', 150)
    await page.waitForTimeout(200)
    // Restore to minimum
    await setRangeValue(page, BIDS, '.range-slider-lo', MIN_POS)
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('Bidders slider, when present, filters and resets cleanly', async ({ page }) => {
    const biddersLabel = page.locator('.range-filter .range-label', { hasText: 'Bidders' })
    test.skip(await biddersLabel.count() === 0, 'No bidder data in current dataset')

    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    // Raising the floor drops lots with few/no distinct bidders.
    await setRangeValue(page, 'Bidders', '.range-slider-lo', 150)
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBeLessThan(totalBefore)

    // Resetting to the minimum restores the original count exactly.
    await setRangeValue(page, 'Bidders', '.range-slider-lo', MIN_POS)
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
    expect(await getRangeSummary(page, 'Bidders')).toBe('Any')
  })

  test('"Ends within: 1 week" reduces visible item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    // Auctions span weeks, so a 1-week cap always excludes the far-future lots.
    await selectEndsWithin(page, '1 week')
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBeLessThan(totalBefore)
  })

  test('resetting "Ends within" to All restores the original count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    await selectEndsWithin(page, '1 week')
    await page.waitForTimeout(200)
    const countFiltered = await getItemCount(page)

    await selectEndsWithin(page, 'All')
    await page.waitForTimeout(200)
    const countReset = await getItemCount(page)

    // Regression guard for #65: "All" clears the upper bound to null (not a finite
    // max), so lots with no parseable end date (Infinity hours) are NOT dropped.
    // Narrowing then resetting must restore the EXACT unfiltered count.
    expect(countFiltered).toBeLessThan(totalBefore)
    expect(countReset).toBe(totalBefore)
  })
})
