import { test, expect } from '@playwright/test'
import { waitForLoad, getItemCount } from './helpers.js'

// ItemGrid's initial batch size — must match BATCH_SIZE in ItemGrid.jsx
const BATCH_SIZE = 50

test.describe('Infinite scroll', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('shows "(showing 50)" when total exceeds the batch size', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= BATCH_SIZE, `Only ${total} items — all fit in first batch`)

    await expect(page.locator('.item-count')).toContainText(`showing ${BATCH_SIZE}`)
  })

  test('scrolling to the sentinel loads the next batch', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= BATCH_SIZE, `Only ${total} items — no infinite scroll needed`)

    // Confirm we start with one batch
    await expect(page.locator('.item-count')).toContainText(`showing ${BATCH_SIZE}`)

    // Scroll the intersection sentinel into view to trigger the observer
    await page.locator('.scroll-sentinel').scrollIntoViewIfNeeded()

    // Wait for the next batch to render
    await expect(page.locator('.item-count')).not.toContainText(`showing ${BATCH_SIZE}`, { timeout: 5_000 })
    const newCountText = await page.locator('.item-count').textContent()
    // Either "showing 100" or all items displayed (no parenthetical)
    expect(newCountText).toMatch(/showing \d+|^\d+ items$/)
  })

  test('repeated scrolling eventually renders all items', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= BATCH_SIZE, `Only ${total} items — no infinite scroll needed`)
    test.skip(total > 500, 'Too many items to scroll through in a single test')

    // Keep scrolling until "(showing X)" is gone
    for (let attempt = 0; attempt < 20; attempt++) {
      const text = await page.locator('.item-count').textContent()
      if (!text.includes('showing')) break
      await page.locator('.scroll-sentinel').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
    }

    const finalText = await page.locator('.item-count').textContent()
    expect(finalText).toMatch(/^\d+ items$/)
  })
})
