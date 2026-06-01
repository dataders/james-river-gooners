import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

test.describe('Filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('search bar accepts input', async ({ page }) => {
    const input = page.locator('input.search-bar')
    await input.fill('antique chair')
    await expect(input).toHaveValue('antique chair')
  })

  test('search narrows item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping filter test')

    await page.locator('input.search-bar').fill('zzz_unlikely_match_xyz')
    // Debounce is 200ms; wait a bit then check
    await page.waitForTimeout(400)
    const countAfter = await getItemCount(page)
    expect(countAfter).toBeLessThan(totalBefore)
  })

  test('clearing search restores item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping filter test')

    const input = page.locator('input.search-bar')
    await input.fill('zzz_unlikely_match_xyz')
    await page.waitForTimeout(400)
    await input.fill('')
    await page.waitForTimeout(400)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('categories panel opens and closes', async ({ page }) => {
    const toggle = page.locator('button.filter-bar-toggle')
    // Panel starts closed
    await expect(page.locator('.filter-bar-body')).toBeHidden()
    await toggle.click()
    await expect(page.locator('.filter-bar-body')).toBeVisible()
    await toggle.click()
    await expect(page.locator('.filter-bar-body')).toBeHidden()
  })

  test('"hide all" categories reduces visible count to 0', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping filter test')

    // Open filter panel
    await page.locator('button.filter-bar-toggle').click()
    // Click the "hide all" action in the filter bar header
    await page.locator('button.filter-bar-toggle').locator('text=hide all').click()
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(0)
  })

  test('"show all" restores all categories', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping filter test')

    await page.locator('button.filter-bar-toggle').click()
    // Hide all, then show all
    await page.locator('button.filter-bar-toggle').locator('text=hide all').click()
    await page.waitForTimeout(200)
    await page.locator('button.filter-bar-toggle').locator('text=show all').click()
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('category "only" isolates a single category in one click', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping filter test')

    await page.locator('button.filter-bar-toggle').click()
    // Expand the first group so its chips (and "only" buttons) render.
    await page.locator('.filter-group-toggle').first().click()
    const onlyBtn = page.locator('.filter-group-body .filter-chip-only').first()
    await expect(onlyBtn).toBeVisible()

    await onlyBtn.click()
    await page.waitForTimeout(200)
    const isolated = await getItemCount(page)
    // Isolating one category must leave fewer items than the full set, but more than zero.
    expect(isolated).toBeGreaterThan(0)
    expect(isolated).toBeLessThan(totalBefore)

    // "show all" undoes it.
    await page.locator('button.filter-bar-toggle').locator('text=show all').click()
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('auctions panel opens and shows auction chips', async ({ page }) => {
    const toggle = page.locator('button.auction-filter-toggle')
    await expect(page.locator('.auction-filter-body')).toBeHidden()
    await toggle.click()
    await expect(page.locator('.auction-filter-body')).toBeVisible()
    // Should have at least one auction chip
    await expect(page.locator('.auction-filter-body .filter-chip').first()).toBeVisible()
  })

  test('"Richmond area only" checkbox is interactive', async ({ page }) => {
    const label = page.locator('label.local-toggle', { hasText: 'Richmond area only' })
    const checkbox = label.locator('input[type="checkbox"]')
    const before = await checkbox.isChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: !before })
    // Restore
    await checkbox.click()
    await expect(checkbox).toBeChecked({ checked: before })
  })

  test('"Archived auctions" checkbox is interactive', async ({ page }) => {
    const label = page.locator('label.local-toggle', { hasText: 'Archived auctions' })
    const checkbox = label.locator('input[type="checkbox"]')
    await expect(checkbox).not.toBeChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked()
    await checkbox.click()
    await expect(checkbox).not.toBeChecked()
  })

  test('"Richmond area only" item count is a subset of the total', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping Richmond-only count test')

    const checkbox = page.locator('label.local-toggle', { hasText: 'Richmond area only' })
      .locator('input[type="checkbox"]')
    await checkbox.click()
    await page.waitForTimeout(200)

    const localCount = await getItemCount(page)
    expect(localCount).toBeLessThanOrEqual(totalBefore)

    // Restore
    await checkbox.click()
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('excluding an auction via chip reduces item count', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping auction chip test')

    // Open the auctions filter panel
    await page.locator('button.auction-filter-toggle').click()
    const chips = page.locator('.auction-filter-body .filter-chip.shown')
    const chipCount = await chips.count()
    test.skip(chipCount < 2, 'Need ≥2 auctions to test exclusion')

    // Exclude the first auction
    await chips.first().click()
    await page.waitForTimeout(200)
    const countAfterExclude = await getItemCount(page)
    expect(countAfterExclude).toBeLessThan(totalBefore)

    // Re-include it (now it's a hidden chip)
    await page.locator('.auction-filter-body .filter-chip.hidden').first().click()
    await page.waitForTimeout(200)
    expect(await getItemCount(page)).toBe(totalBefore)
  })

  test('toggling a single category chip excludes that category', async ({ page }) => {
    const totalBefore = await getItemCount(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping category chip test')

    // Open categories panel and expand the first group
    await page.locator('button.filter-bar-toggle').click()
    await page.locator('.filter-group-toggle').first().click()

    // Get the first shown chip and click it to exclude
    const chip = page.locator('.filter-group-body .filter-chip.shown').first()
    await expect(chip).toBeVisible()
    await chip.click()
    await page.waitForTimeout(200)

    expect(await getItemCount(page)).toBeLessThan(totalBefore)

    // Restore via "show all"
    const showAllBtn = page.locator('button.filter-bar-toggle').locator('text=show all')
    if (await showAllBtn.isVisible()) {
      await showAllBtn.click()
      await page.waitForTimeout(200)
      expect(await getItemCount(page)).toBe(totalBefore)
    }
  })
})
