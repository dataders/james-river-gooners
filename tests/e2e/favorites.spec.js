import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

test.describe('Favorites', () => {
  test.beforeEach(async ({ page }) => {
    // Clear the favorites cookie before each test
    await page.goto('/')
    await page.evaluate(() => {
      document.cookie = 'gooners-favorites=; path=/; max-age=0'
    })
    await waitForLoad(page)
  })

  test('clicking the favorite button on a card marks it with a filled star', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'No items loaded — skipping favorites test')

    const favBtn = page.locator('.item-card').first().locator('.favorite-button')
    await expect(favBtn).toContainText('☆')
    await favBtn.click()
    await expect(favBtn).toContainText('★')
  })

  test('unfavoriting removes the filled star', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'No items loaded — skipping favorites test')

    const favBtn = page.locator('.item-card').first().locator('.favorite-button')
    await favBtn.click()
    await expect(favBtn).toContainText('★')
    await favBtn.click()
    await expect(favBtn).toContainText('☆')
  })

  test('favorite persists after navigating away and back (cookie-based)', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'No items loaded — skipping favorites persistence test')

    // Favorite the first card
    const favBtn = page.locator('.item-card').first().locator('.favorite-button')
    await favBtn.click()
    await expect(favBtn).toContainText('★')

    // Navigate fresh — cookie survives same-origin navigation
    await page.goto('/')
    await waitForLoad(page)

    await expect(page.locator('.item-card').first().locator('.favorite-button')).toContainText('★')
  })

  test('favorite does not persist after the cookie is cleared', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'No items loaded — skipping favorites persistence test')

    await page.locator('.item-card').first().locator('.favorite-button').click()

    // Manually clear the cookie
    await page.evaluate(() => {
      document.cookie = 'gooners-favorites=; path=/; max-age=0'
    })
    await page.goto('/')
    await waitForLoad(page)

    await expect(page.locator('.item-card').first().locator('.favorite-button')).toContainText('☆')
  })

  test('favoriting in the detail modal is reflected on the card', async ({ page }) => {
    const count = await getItemCount(page)
    test.skip(count === 0, 'No items loaded — skipping favorites test')

    // Open detail modal and favorite from there
    await page.locator('.item-card').first().click()
    const modalFavBtn = page.locator('.detail-panel .favorite-button')
    await modalFavBtn.click()
    await expect(modalFavBtn).toContainText('★')

    // Close modal and check the card star
    await page.locator('button.detail-close').click()
    await expect(page.locator('.item-card').first().locator('.favorite-button')).toContainText('★')
  })
})
