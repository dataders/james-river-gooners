import { test, expect } from '@playwright/test'

async function waitForLoad(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
}

async function getItemCount(page) {
  const text = await page.locator('.item-count').textContent()
  const match = text.match(/^(\d+) items/)
  return match ? parseInt(match[1], 10) : 0
}

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
})
