import { test, expect } from '@playwright/test'

const STORAGE_KEY = 'gooners-preferences'

async function waitForLoad(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
}

test.describe('Preference persistence', () => {
  test.beforeEach(async ({ page }) => {
    // Start from a clean slate so tests don't bleed into each other
    await page.goto('/')
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY)
  })

  test('dark/light mode persists across page reload', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    // Determine current theme and toggle it
    const html = page.locator('html')
    const before = await html.getAttribute('data-theme')
    await page.locator('button[aria-label*="theme"], button.theme-toggle, button[class*="theme"]').first().click()
    const after = await html.getAttribute('data-theme')
    expect(after).not.toBe(before)

    // Reload and confirm the new theme survived
    await page.reload()
    await waitForLoad(page)
    await expect(html).toHaveAttribute('data-theme', after)
  })

  test('Richmond area only checkbox persists across page reload', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    const checkbox = page.locator('label.local-toggle', { hasText: 'Richmond area only' }).locator('input[type="checkbox"]')
    await expect(checkbox).not.toBeChecked()
    await checkbox.click()
    await expect(checkbox).toBeChecked()

    await page.reload()
    await waitForLoad(page)
    await expect(checkbox).toBeChecked()
  })

  test('price range filter persists across page reload', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    // Set a max price value in the range filter input
    const maxPriceInput = page.locator('input[aria-label*="max price" i], input[placeholder*="max" i]').first()
    test.skip(!(await maxPriceInput.count()), 'No max price input found — skipping')

    await maxPriceInput.fill('250')
    await maxPriceInput.blur()
    await page.waitForTimeout(300)

    await page.reload()
    await waitForLoad(page)

    await expect(maxPriceInput).toHaveValue('250')
  })

  test('localOnly preference is written to localStorage', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    const checkbox = page.locator('label.local-toggle', { hasText: 'Richmond area only' }).locator('input[type="checkbox"]')
    await checkbox.click()
    await expect(checkbox).toBeChecked()

    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }, STORAGE_KEY)

    expect(stored).not.toBeNull()
    expect(stored.localOnly).toBe(true)
  })

  test('category exclusions persist across page reload', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    // Open the filter bar and hide all categories
    const toggle = page.locator('button.filter-bar-toggle')
    const filterBody = page.locator('.filter-bar-body')
    await toggle.click()
    await expect(filterBody).toBeVisible()

    const hideAllBtn = filterBody.locator('button', { hasText: /hide all/i })
    if (!(await hideAllBtn.count())) {
      // Try clicking the toggle itself which may contain hide all
      await page.locator('button.filter-bar-toggle').locator('text=hide all').click()
    } else {
      await hideAllBtn.click()
    }
    await page.waitForTimeout(200)

    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }, STORAGE_KEY)

    expect(stored).not.toBeNull()
    expect(Array.isArray(stored.excludedCategories)).toBe(true)
    expect(stored.excludedCategories.length).toBeGreaterThan(0)

    // Reload and verify exclusions still applied
    await page.reload()
    await waitForLoad(page)

    const storedAfterReload = await page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }, STORAGE_KEY)
    expect(storedAfterReload.excludedCategories.length).toBeGreaterThan(0)
  })
})
