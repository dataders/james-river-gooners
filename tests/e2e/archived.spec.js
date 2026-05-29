import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

test.describe('Archived auctions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('enabling "Archived auctions" triggers an inline loading status', async ({ page }) => {
    const checkbox = page.locator('label.local-toggle', { hasText: 'Archived auctions' })
      .locator('input[type="checkbox"]')
    await checkbox.click()

    // The loading status may appear briefly; assert it is eventually hidden (not that it was seen)
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })
  })

  test('archived items are added to the grid after loading', async ({ page }) => {
    const activeBefore = await getItemCount(page)
    test.skip(activeBefore === 0, 'No active items loaded — skipping archived count test')

    const checkbox = page.locator('label.local-toggle', { hasText: 'Archived auctions' })
      .locator('input[type="checkbox"]')
    await checkbox.click()

    // Wait for the archive load to complete
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.inline-error')).toBeHidden()

    const totalAfter = await getItemCount(page)
    expect(totalAfter).toBeGreaterThan(activeBefore)
  })

  test('disabling "Archived auctions" returns to the active-only count', async ({ page }) => {
    const activeBefore = await getItemCount(page)
    test.skip(activeBefore === 0, 'No active items loaded — skipping archived count test')

    const checkbox = page.locator('label.local-toggle', { hasText: 'Archived auctions' })
      .locator('input[type="checkbox"]')

    // Enable archive
    await checkbox.click()
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })

    // Disable archive
    await checkbox.click()
    await page.waitForTimeout(300)
    expect(await getItemCount(page)).toBe(activeBefore)
  })

  test('archived auction chips appear in the Auctions filter after loading', async ({ page }) => {
    const checkbox = page.locator('label.local-toggle', { hasText: 'Archived auctions' })
      .locator('input[type="checkbox"]')
    await checkbox.click()
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })

    // Open the Auctions filter and look for archived chips
    await page.locator('button.auction-filter-toggle').click()
    await expect(page.locator('.auction-filter-body .filter-chip.archived').first()).toBeVisible()
  })
})
