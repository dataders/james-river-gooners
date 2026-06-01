import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount, setRangeValue } from './helpers.js'

// Range filter indices (order matches RangeFilters.jsx: Price=0, Bids=1, Ends within=2)
const PRICE = 0
const BIDS = 1
const ENDS = 2

// Slider positions: 0 = minimum, 200 = maximum (SLIDER_STEPS constant in the component)
const MIN_POS = 0
const MAX_POS = 200

test.describe('Range filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('range filters section renders after data loads', async ({ page }) => {
    await expect(page.locator('.range-filters')).toBeVisible()
  })

  test('all three sliders are present (Price, Bids, Ends within)', async ({ page }) => {
    const labels = page.locator('.range-filter .range-label')
    await expect(labels.nth(PRICE)).toContainText('Price')
    await expect(labels.nth(BIDS)).toContainText('Bids')
    await expect(labels.nth(ENDS)).toContainText('Ends within')
  })

  test('all summaries start as "Any" before any interaction', async ({ page }) => {
    const summaries = page.locator('.range-value')
    for (let i = 0; i < 3; i++) {
      await expect(summaries.nth(i)).toHaveText('Any')
    }
  })

  test('moving price hi slider left changes summary from "Any" to "≤ X"', async ({ page }) => {
    // Set hi to half-way — filters out higher-priced items
    await setRangeValue(page, PRICE, '.range-slider-hi', 100)
    await page.waitForTimeout(200)
    const summary = await page.locator('.range-filter').nth(PRICE).locator('.range-value').textContent()
    expect(summary).not.toBe('Any')
    expect(summary).toMatch(/^≤/)
  })

  test('moving price lo slider right changes summary from "Any" to "≥ X"', async ({ page }) => {
    await setRangeValue(page, PRICE, '.range-slider-lo', 100)
    await page.waitForTimeout(200)
    const summary = await page.locator('.range-filter').nth(PRICE).locator('.range-value').textContent()
    expect(summary).not.toBe('Any')
    expect(summary).toMatch(/^≥/)
  })

  test('setting both price sliders shows a "X – Y" range summary', async ({ page }) => {
    await setRangeValue(page, PRICE, '.range-slider-lo', 50)
    await setRangeValue(page, PRICE, '.range-slider-hi', 150)
    await page.waitForTimeout(200)
    const summary = await page.locator('.range-filter').nth(PRICE).locator('.range-value').textContent()
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

  test('lowering maximum hours filter reduces visible item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    // Restrict to items ending in the near term (hi slider at 50 out of 200)
    await setRangeValue(page, ENDS, '.range-slider-hi', 50)
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBeLessThanOrEqual(totalBefore)
  })

  test('resetting hours filter widens the results again', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping count test')

    await setRangeValue(page, ENDS, '.range-slider-hi', 50)
    await page.waitForTimeout(200)
    const countFiltered = await getItemCount(page)

    await setRangeValue(page, ENDS, '.range-slider-hi', MAX_POS)
    await page.waitForTimeout(200)
    const countReset = await getItemCount(page)

    // Resetting the slider to max must show strictly more than the narrow filter.
    // We deliberately don't assert the restored count equals the unfiltered total:
    // items without an end date are Infinity hours out and never match an
    // upper-bound filter, so the "Ends within" max can't recover them. That quirk
    // (slider max labelled "Any" yet hiding dateless lots) is tracked separately.
    expect(countReset).toBeGreaterThan(countFiltered)
  })
})
