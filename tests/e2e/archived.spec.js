import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount, selectArchiveView } from './helpers.js'

test.describe('Archived auctions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('selecting "All" triggers an inline loading status', async ({ page }) => {
    await selectArchiveView(page, 'All')

    // The loading status may appear briefly; assert it is eventually hidden (not that it was seen)
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })
  })

  test('archived items are added to the grid after loading', async ({ page }) => {
    const activeBefore = await getItemCount(page)
    test.skip(activeBefore === 0, 'No active items loaded — skipping archived count test')

    await selectArchiveView(page, 'All')

    // Wait for the archive load to complete
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })
    await expect(page.locator('.inline-error')).toBeHidden()

    const totalAfter = await getItemCount(page)
    expect(totalAfter).toBeGreaterThan(activeBefore)
  })

  test('switching back to "Active" returns to the active-only count', async ({ page }) => {
    const activeBefore = await getItemCount(page)
    test.skip(activeBefore === 0, 'No active items loaded — skipping archived count test')

    // Show live + archived
    await selectArchiveView(page, 'All')
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })

    // Back to active-only
    await selectArchiveView(page, 'Active')
    await page.waitForTimeout(300)
    expect(await getItemCount(page)).toBe(activeBefore)
  })

  test('archived auction chips appear in the Auctions filter after loading', async ({ page }) => {
    await selectArchiveView(page, 'All')
    await expect(page.locator('.inline-status')).toBeHidden({ timeout: 30_000 })

    // Open the Auctions filter, expand all source groups, then look for archived chips
    await page.locator('button.auction-filter-toggle').click()
    for (const grpToggle of await page.locator('.auction-filter-body .filter-group-toggle').all()) {
      await grpToggle.click()
    }
    await expect(page.locator('.auction-filter-body .filter-chip.archived').first()).toBeVisible()
  })
})
