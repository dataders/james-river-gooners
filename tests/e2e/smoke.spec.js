import { test, expect } from '@playwright/test'

// Wait for the app to finish loading Parquet data (WASM + fetch)
async function waitForLoad(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
}

test.describe('Smoke — basic app structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('logo and tagline are visible', async ({ page }) => {
    await expect(page.locator('h1.logo')).toContainText('Gooners')
    await expect(page.locator('.tagline')).toContainText("Cannon's Auctions")
  })

  test('search bar is present with correct placeholder', async ({ page }) => {
    const input = page.locator('input.search-bar')
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute('placeholder', 'Search items...')
  })

  test('theme toggle button is visible', async ({ page }) => {
    await expect(page.locator('button.theme-toggle')).toBeVisible()
  })

  test('categories filter toggle is visible', async ({ page }) => {
    await expect(page.locator('button.filter-bar-toggle')).toContainText('Categories')
  })

  test('auctions filter toggle is visible', async ({ page }) => {
    await expect(page.locator('button.auction-filter-toggle')).toContainText('Auctions')
  })

  test('view checkboxes are present', async ({ page }) => {
    await expect(page.getByText('Richmond area only')).toBeVisible()
    await expect(page.getByText('Archived auctions')).toBeVisible()
  })

  test('loading state resolves within 20s', async ({ page }) => {
    await waitForLoad(page)
  })

  test('item count is shown after load', async ({ page }) => {
    await waitForLoad(page)
    const countEl = page.locator('.item-count')
    await expect(countEl).toBeVisible()
    const text = await countEl.textContent()
    expect(text).toMatch(/^\d+ items/)
  })
})
