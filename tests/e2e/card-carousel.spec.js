// E2E tests for the ItemCard image carousel: hover to load, arrow navigation,
// dot navigation, and swipe gesture. These complement the detail-panel carousel
// tests in item-detail.spec.js — selectors here use the card-level `card-carousel-*`
// classes, not the detail panel's `carousel-*` classes.

import { test, expect } from './fixtures.js'
import { waitForLoad } from './helpers.js'

test.describe('Card carousel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('hovering a card triggers full-image load and shows dots', async ({ page }) => {
    // The _card view serves one image per lot. Hovering triggers useFullImages,
    // which fetches from public_active_lots — the mock returns [IMG, IMG] for
    // every lot, so hovering should produce 2 dots.
    const card = page.locator('.item-card').first()
    await card.locator('.item-image').hover()

    const dots = card.locator('.card-carousel-dots')
    await expect(dots).toBeVisible({ timeout: 5_000 })
    await expect(card.locator('.card-carousel-dot')).toHaveCount(2)
    await expect(card.locator('.card-carousel-dot.active')).toHaveCount(1)
  })

  test('next/prev arrow buttons advance and retreat the active dot', async ({ page }) => {
    const card = page.locator('.item-card').first()
    await card.locator('.item-image').hover()

    // Wait for the carousel to load and arrows to appear
    await expect(card.locator('.card-carousel-next')).toBeVisible({ timeout: 5_000 })

    // Advance: first dot active → second dot active
    await card.locator('.card-carousel-next').click()
    await expect(card.locator('.card-carousel-dot').nth(1)).toHaveClass(/active/)
    await expect(card.locator('.card-carousel-dot').nth(0)).not.toHaveClass(/active/)

    // Retreat: back to first dot
    await card.locator('.card-carousel-prev').click()
    await expect(card.locator('.card-carousel-dot').nth(0)).toHaveClass(/active/)
    await expect(card.locator('.card-carousel-dot').nth(1)).not.toHaveClass(/active/)
  })

  test('clicking a dot jumps directly to that image', async ({ page }) => {
    const card = page.locator('.item-card').first()
    await card.locator('.item-image').hover()
    await expect(card.locator('.card-carousel-dots')).toBeVisible({ timeout: 5_000 })

    // Click the second dot directly
    await card.locator('.card-carousel-dot').nth(1).click()

    await expect(card.locator('.card-carousel-dot').nth(1)).toHaveClass(/active/)
    await expect(card.locator('.card-carousel-dot').nth(0)).not.toHaveClass(/active/)
  })

  test('arrow navigation does not open the item detail panel', async ({ page }) => {
    const card = page.locator('.item-card').first()
    await card.locator('.item-image').hover()
    await expect(card.locator('.card-carousel-next')).toBeVisible({ timeout: 5_000 })

    await card.locator('.card-carousel-next').click()

    await expect(page.locator('.detail-overlay')).toBeHidden()
  })

  test('touch swipe on a card advances the image', async ({ page }) => {
    // Trigger image load first via hover so the carousel has images to swipe through.
    const card = page.locator('.item-card').first()
    const imageArea = card.locator('.item-image')
    await imageArea.hover()
    await expect(card.locator('.card-carousel-dots')).toBeVisible({ timeout: 5_000 })

    const box = await imageArea.boundingBox()
    if (!box) test.skip(true, 'Could not get image bounding box')

    const midY = box.y + box.height / 2
    const startX = box.x + box.width * 0.8
    const endX = box.x + box.width * 0.2

    // Use JS-driven swipe since Playwright's touchscreen API requires hasTouch context
    await page.evaluate(({ sx, ex, y }) => {
      const el = document.querySelector('.item-image')
      const t = (x, cy) => new Touch({ identifier: 1, target: el, clientX: x, clientY: cy })
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t(sx, y)] }))
      el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t(ex, y)] }))
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [t(ex, y)] }))
    }, { sx: startX, ex: endX, y: midY })

    await expect(card.locator('.card-carousel-dot').nth(1)).toHaveClass(/active/, { timeout: 3_000 })
    await expect(card.locator('.card-carousel-dot').nth(0)).not.toHaveClass(/active/)
  })
})
