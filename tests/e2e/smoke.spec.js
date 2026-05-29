import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

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
    await expect(page.locator('.item-count')).toBeVisible()
    expect(await getItemCount(page)).toBeGreaterThan(0)
  })
})

test.describe('Arsenal Trivia card', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('trivia card is visible', async ({ page }) => {
    await expect(page.locator('.trivia-card')).toBeVisible()
  })

  test('shows question and tap hint before reveal', async ({ page }) => {
    await expect(page.locator('.trivia-question')).toBeVisible()
    await expect(page.locator('.trivia-tap-hint')).toBeVisible()
    await expect(page.locator('.trivia-answer')).toBeHidden()
  })

  test('clicking trivia reveals answer and hides hint', async ({ page }) => {
    await page.locator('.trivia-card').click()
    await expect(page.locator('.trivia-answer')).toBeVisible()
    await expect(page.locator('.trivia-tap-hint')).toBeHidden()
  })

  test('clicking again hides the answer', async ({ page }) => {
    await page.locator('.trivia-card').click()
    await page.locator('.trivia-card').click()
    await expect(page.locator('.trivia-answer')).toBeHidden()
    await expect(page.locator('.trivia-tap-hint')).toBeVisible()
  })

  test('trivia card has aria-expanded that reflects reveal state', async ({ page }) => {
    await expect(page.locator('.trivia-card')).toHaveAttribute('aria-expanded', 'false')
    await page.locator('.trivia-card').click()
    await expect(page.locator('.trivia-card')).toHaveAttribute('aria-expanded', 'true')
  })
})
