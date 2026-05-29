import { test, expect } from '@playwright/test'

async function waitForItems(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
  // Return item count so callers can skip if empty
  const text = await page.locator('.item-count').textContent()
  const match = text?.match(/^(\d+) items/)
  return match ? parseInt(match[1], 10) : 0
}

test.describe('Item detail modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('clicking an item card opens the detail modal', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    await expect(page.locator('.detail-panel')).toBeVisible()
  })

  test('detail modal shows title, bid, and category', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-title')).toBeVisible()
    await expect(page.locator('.detail-bid')).toBeVisible()
    await expect(page.locator('.detail-category')).toBeVisible()
  })

  test('close button dismisses the modal', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()

    await page.locator('button.detail-close').click()
    await expect(page.locator('.detail-overlay')).toBeHidden()
  })

  test('Escape key dismisses the modal', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('.detail-overlay')).toBeHidden()
  })

  test('clicking the overlay backdrop dismisses the modal', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()

    // Click the overlay outside the panel
    await page.locator('.detail-overlay').click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.detail-overlay')).toBeHidden()
  })

  test('favorite button toggles in modal', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    await page.locator('.item-card').first().click()
    const favBtn = page.locator('.detail-panel .favorite-button')
    const before = await favBtn.textContent()
    await favBtn.click()
    const after = await favBtn.textContent()
    expect(after).not.toBe(before)
    // Clean up
    await favBtn.click()
  })

  test('modal does not open when clicking favorite on card', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping item detail test')

    const card = page.locator('.item-card').first()
    await card.locator('.favorite-button').click()
    await expect(page.locator('.detail-overlay')).toBeHidden()
    // Clean up favorite
    await card.locator('.favorite-button').click()
  })
})
