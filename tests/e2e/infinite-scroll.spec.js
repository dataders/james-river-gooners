import { test, expect } from './fixtures.js'
import { waitForLoad, getItemCount } from './helpers.js'

// The grid is window-virtualized (TanStack Virtual): only a window of cells is
// mounted at once and more mount as you scroll, replacing the old fixed-batch
// "(showing N)" + IntersectionObserver sentinel mechanism.

// Largest data-index currently mounted in the grid.
async function maxMountedIndex(page) {
  return page.locator('.virtual-grid-cell').evaluateAll(
    els => els.reduce((m, el) => Math.max(m, Number(el.dataset.index)), -1)
  )
}

test.describe('Grid virtualization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
  })

  test('mounts only a window of cells, not the whole list', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= 60, `Only ${total} items — list fits without virtualizing`)

    const mounted = await page.locator('.virtual-grid-cell').count()
    // Far fewer nodes than the logical total — that's the point of virtualizing.
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(total)
  })

  test('scrolling mounts later items', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= 60, `Only ${total} items — no scrolling needed`)

    const before = await maxMountedIndex(page)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2))
    await page.waitForTimeout(500)
    const after = await maxMountedIndex(page)
    expect(after).toBeGreaterThan(before)
  })

  test('scrolling to the bottom reaches the last item', async ({ page }) => {
    const total = await getItemCount(page)
    test.skip(total <= 60, `Only ${total} items — no scrolling needed`)
    test.skip(total > 2000, 'Too many items to scroll through in a single test')

    // Repeatedly jump to the current document bottom; the total height grows as
    // real heights replace estimates, so a few passes converge on the last row.
    let max = -1
    for (let i = 0; i < 40; i++) {
      max = await maxMountedIndex(page)
      if (max >= total - 1) break
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      await page.waitForTimeout(150)
    }
    expect(max).toBeGreaterThanOrEqual(total - 2)
  })
})
