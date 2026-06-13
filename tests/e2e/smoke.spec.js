import { test, expect } from './fixtures.js'
import { waitForLoad, getItemCount } from './helpers.js'

test.describe('Smoke — basic app structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('logo and tagline are visible', async ({ page }) => {
    await expect(page.locator('h1.logo')).toContainText('Gooners')
    await expect(page.locator('.tagline')).toContainText("RVA auctions")
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

  test('view controls are present', async ({ page }) => {
    await expect(page.getByText('Richmond area only')).toBeVisible()
    // Archive view is a segmented control (Active / All / Archived).
    const group = page.getByRole('group', { name: 'Which auctions to show' })
    await expect(group.getByRole('button', { name: 'Active', exact: true })).toBeVisible()
    await expect(group.getByRole('button', { name: 'Archived', exact: true })).toBeVisible()
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

  // Trivia now lives behind a ⚽ button in the header banner; open it first.
  const openTrivia = (page) => page.locator('.trivia-button').click()

  test('trivia card opens from the header button', async ({ page }) => {
    await expect(page.locator('.trivia-card')).toBeHidden()
    await openTrivia(page)
    await expect(page.locator('.trivia-card')).toBeVisible()
  })

  test('shows question and tap hint before reveal', async ({ page }) => {
    await openTrivia(page)
    await expect(page.locator('.trivia-question')).toBeVisible()
    await expect(page.locator('.trivia-tap-hint')).toBeVisible()
    await expect(page.locator('.trivia-answer')).toBeHidden()
  })

  test('clicking trivia body reveals answer and hides hint', async ({ page }) => {
    await openTrivia(page)
    await page.locator('.trivia-body').click()
    await expect(page.locator('.trivia-answer')).toBeVisible()
    await expect(page.locator('.trivia-tap-hint')).toBeHidden()
  })

  test('clicking trivia body again hides the answer', async ({ page }) => {
    await openTrivia(page)
    await page.locator('.trivia-body').click()
    await page.locator('.trivia-body').click()
    await expect(page.locator('.trivia-answer')).toBeHidden()
    await expect(page.locator('.trivia-tap-hint')).toBeVisible()
  })

  test('trivia body has aria-expanded that reflects reveal state', async ({ page }) => {
    await openTrivia(page)
    await expect(page.locator('.trivia-body')).toHaveAttribute('aria-expanded', 'false')
    await page.locator('.trivia-body').click()
    await expect(page.locator('.trivia-body')).toHaveAttribute('aria-expanded', 'true')
  })
})
