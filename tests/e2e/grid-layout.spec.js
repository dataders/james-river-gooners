import { test, expect } from '@playwright/test'
import { waitForLoad } from './helpers.js'

// Regression guard for the masonry grid overflowing the viewport on laptop /
// desktop widths (#84, #110, #121). The bug came back twice because the column
// count was derived from window.innerWidth while the grid only gets
// window − sidebar − padding (~350px less), so a window-based breakpoint picked
// one column too many and pushed the last card off the right edge.
//
// These widths span the ranges that previously broke: the 1440–2000px band that
// #110 set to 4 columns, plus the sidebar boundary (1024) and an ultrawide case.
// We assert the document never scrolls horizontally and the grid's right edge
// stays inside the viewport — independent of *how* columns are chosen, so it
// holds whatever breakpoint scheme a future change uses.
const WIDTHS = [1024, 1280, 1366, 1440, 1512, 1680, 1920, 2200]

test.describe('Grid layout — no horizontal overflow', () => {
  for (const width of WIDTHS) {
    test(`grid fits within a ${width}px viewport`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      await waitForLoad(page)

      // At least one column rendered, so we're actually measuring the grid.
      await expect(page.locator('.masonry-column').first()).toBeVisible()

      const metrics = await page.evaluate(() => {
        const doc = document.documentElement
        const grid = document.querySelector('.masonry-grid')
        return {
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          gridRight: grid ? Math.round(grid.getBoundingClientRect().right) : 0,
        }
      })

      // No horizontal scrollbar (allow 1px for sub-pixel rounding).
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
      // The grid's right edge stays within the viewport.
      expect(metrics.gridRight).toBeLessThanOrEqual(width + 1)
    })
  }
})
