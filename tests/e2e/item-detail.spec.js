import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

async function waitForItems(page) {
  await waitForLoad(page)
  return getItemCount(page)
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

  test('"Open on Cannon\'s" link is present and opens in a new tab', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping link test')

    // Try up to 5 items to find one with a detailUrl (most will have one)
    let found = false
    for (let i = 0; i < Math.min(count, 5); i++) {
      await page.locator('.item-card').nth(i).click()
      const link = page.locator('a.detail-link', { hasText: "Open on Cannon's" })
      if (await link.isVisible()) {
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
        found = true
        break
      }
      await page.locator('button.detail-close').click()
    }
    test.skip(!found, 'No items had a Cannon\'s detail URL in the first 5 cards')
    await page.locator('button.detail-close').click()
  })

  test('eBay comps section appears for items with searchable titles', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping eBay comps test')

    // Try up to 10 items to find one where EbayComps renders something
    let found = false
    for (let i = 0; i < Math.min(count, 10); i++) {
      await page.locator('.item-card').nth(i).click()
      if (await page.locator('.ebay-comps').isVisible()) {
        await expect(page.locator('.ebay-comps h3')).toContainText('eBay sold comps')
        // Either sold comp cards or a search link should be present
        const hasCards = await page.locator('.ebay-comp-card-sold').count() > 0
        const hasLink = await page.locator('.ebay-comps-search').count() > 0 ||
                        await page.locator('.ebay-comps-all').count() > 0
        expect(hasCards || hasLink).toBe(true)
        found = true
        break
      }
      await page.locator('button.detail-close').click()
    }
    test.skip(!found, 'No items triggered eBay comps section in the first 10 cards')
    await page.locator('button.detail-close').click()
  })

  test('image carousel shows prev/next buttons when item has multiple images', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping carousel test')

    // Try up to 20 items to find one with a multi-image carousel
    let found = false
    for (let i = 0; i < Math.min(count, 20); i++) {
      await page.locator('.item-card').nth(i).click()
      if (await page.locator('.carousel-next').isVisible()) {
        // Both prev and next buttons are present
        await expect(page.locator('.carousel-prev')).toBeVisible()
        // Verify carousel dots are rendered and one is active
        await expect(page.locator('.carousel-dots')).toBeVisible()
        await expect(page.locator('.carousel-dot.active')).toBeVisible()
        // Click next via JS to avoid the detail-close button intercepting the pointer
        await page.evaluate(() => document.querySelector('.carousel-next').click())
        // Panel stays open after carousel interaction
        await expect(page.locator('.detail-panel')).toBeVisible()
        found = true
        break
      }
      await page.locator('button.detail-close').click()
    }
    test.skip(!found, 'No multi-image items found in the first 20 cards')
    await page.locator('button.detail-close').click()
  })
})
