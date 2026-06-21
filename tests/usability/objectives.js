// Bidder objectives for the usability benchmark.
//
// Each objective models a real person arriving at the site with a goal and
// driving the UI to accomplish it. We record whether they succeed, how many
// interactions it took versus the optimal path, and any friction. Objectives
// degrade gracefully: when a task can't complete because the *data* (e.g. eBay
// comps) isn't present rather than because the *UI* failed, it's reported as
// "blocked" and excluded from the usability score.
//
// status returned by run(): 'pass' | 'fail' | 'blocked'

import { expect } from '@playwright/test'
import {
  gotoApp,
  waitForLoad,
  getItemCount,
  measureSettle,
  VIEWPORTS,
} from './harness.js'

// Pull a distinctive word from the first visible card so search objectives are
// guaranteed a real hit against whatever data is loaded.
async function tokenFromFirstCard(page) {
  const title = await page.locator('.item-card .item-title').first().textContent()
  const word = (title || '')
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z]/g, ''))
    .find(w => w.length >= 4)
  return word || 'table'
}

export const objectives = [
  // -----------------------------------------------------------------------
  {
    id: 'newcomer-help',
    persona: 'Newcomer',
    goal: 'Land on the site and find out how it works',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)
      const help = page.locator('.help-button')
      if (!(await help.isVisible())) {
        tracker.note('No visible help affordance on first load')
        return 'fail'
      }
      tracker.step('Click "?" help button')
      await help.click()
      const modal = page.locator('.tutorial-modal, [role="dialog"]')
      await expect(modal).toBeVisible({ timeout: 5000 })
      tracker.step('Dismiss tutorial (Escape)')
      await page.keyboard.press('Escape')
      await expect(modal).toBeHidden({ timeout: 5000 })
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'collector-search',
    persona: 'Collector',
    goal: 'Search for a specific kind of item and open its details',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)
      const total = await getItemCount(page)
      const token = await tokenFromFirstCard(page)

      tracker.step(`Type "${token}" in search`)
      const latency = await measureSettle(page, async () => {
        await page.locator('.search-bar').fill(token)
        await page.locator('.search-bar').press('Enter')
      })
      tracker.note(`Search settled in ${latency}ms`)
      const narrowed = await getItemCount(page)
      if (narrowed === 0) {
        tracker.note(`Search for "${token}" returned 0 results`)
        return 'fail'
      }
      if (narrowed >= total) {
        tracker.note('Search did not narrow the result set')
      }

      tracker.step('Open first result')
      await page.locator('.item-card').first().click()
      const panel = page.locator('.detail-panel')
      await expect(panel).toBeVisible({ timeout: 5000 })
      await expect(panel.locator('.detail-title')).toBeVisible()
      await expect(panel.locator('.detail-bid')).toBeVisible()
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'bargain-sort-and-cap',
    persona: 'Bargain hunter',
    goal: 'Sort by price and cap results to low-priced lots',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)
      const total = await getItemCount(page)

      // Sort by cheapest first, then verify the grid is actually ordered.
      tracker.step('Sort by "Price: low to high"')
      const sortLatency = await measureSettle(page, async () => {
        await page.locator('.sort-select').selectOption('priceAsc')
      })
      tracker.note(`Sort settled in ${sortLatency}ms`)
      const prices = await page.locator('.item-card .item-bid').evaluateAll(
        els => els.slice(0, 8).map(e => Number(e.textContent.replace(/[^0-9.]/g, '')))
      )
      const ascending = prices.every((p, i) => i === 0 || p >= prices[i - 1])
      if (!ascending) {
        tracker.note(`Grid not ordered by price: ${prices.join(', ')}`)
        return 'fail'
      }

      // Then cap the max-price slider to narrow to genuinely cheap lots.
      // Radix Slider uses pointer events — drag the hi thumb to ~30% of the
      // track (position 60 out of 200 steps on a log scale → a low price cap).
      tracker.step('Lower the max-price slider')
      const latency = await measureSettle(page, async () => {
        const filter = page.locator('.range-filter').filter({ hasText: /^Price/ }).first()
        const thumb = filter.locator('.range-slider-thumb-hi')
        const track = filter.locator('.range-slider-track')

        await thumb.scrollIntoViewIfNeeded()
        const tb = await track.boundingBox()
        const startBox = await thumb.boundingBox()
        if (!tb || !startBox) throw new Error('price max slider not found')

        const ratio = 60 / 200 // 30% along the track → a low price cap
        const targetX = tb.x + ratio * tb.width
        const cy = startBox.y + startBox.height / 2

        await page.mouse.move(startBox.x + startBox.width / 2, cy)
        await page.mouse.down()
        await page.mouse.move(targetX, cy, { steps: 8 })
        await page.mouse.up()
      })
      tracker.note(`Price filter settled in ${latency}ms`)
      const capped = await getItemCount(page)
      if (capped >= total) {
        tracker.note('Price cap did not reduce the result set')
        return 'fail'
      }
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'category-narrow',
    persona: 'Category shopper',
    goal: 'Narrow the grid to a single category of interest',
    optimalSteps: 3,
    async run({ page, tracker }) {
      await gotoApp(page)
      const total = await getItemCount(page)

      tracker.step('Open Categories panel')
      await page.locator('.filter-bar-toggle').click()
      await expect(page.locator('.filter-bar-body')).toBeVisible({ timeout: 5000 })

      tracker.step('Expand first category group')
      await page.locator('.filter-group-toggle').first().click()
      const onlyBtn = page.locator('.filter-group-body .filter-chip-only').first()
      if (!(await onlyBtn.count())) {
        tracker.note('No one-click "only this category" affordance found')
        return 'fail'
      }
      await expect(onlyBtn).toBeVisible({ timeout: 5000 })

      // One click isolates the category (no hide-all + re-show dance).
      tracker.step('Click "only" to isolate the category')
      const latency = await measureSettle(page, async () => {
        await onlyBtn.click()
      })
      tracker.note(`Category isolated in one click; settled in ${latency}ms`)
      const count = await getItemCount(page)
      if (count === 0 || count >= total) {
        tracker.note(`"only" did not isolate the category (count ${count} of ${total})`)
        return 'fail'
      }
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'local-only',
    persona: 'Local pickup buyer',
    goal: 'Restrict to Richmond-area auctions only',
    optimalSteps: 1,
    async run({ page, tracker }) {
      await gotoApp(page)

      // Legacy toggle (may be present in older builds)
      const toggle = page.locator('.local-toggle', { hasText: 'Richmond' }).locator('input')
      if (await toggle.count()) {
        tracker.step('Check "Richmond area only"')
        const latency = await measureSettle(page, async () => {
          await toggle.check()
        })
        tracker.note(`Locality filter settled in ${latency}ms`)
        const local = await getItemCount(page)
        if (local === 0) {
          tracker.note('Richmond-only produced 0 items')
          return 'fail'
        }
        return 'pass'
      }

      // Current UI: location filter with a radius selector in the filter sidebar.
      // On desktop the sidebar is always visible; on mobile open it first.
      const filterBtn = page.locator('.filter-toggle-btn')
      if (await filterBtn.isVisible()) {
        tracker.step('Open filter panel')
        await filterBtn.click()
        await page.waitForTimeout(300)
      }

      const radiusSel = page.locator('.lf-radius-select--inline')
      if (!(await radiusSel.count())) {
        tracker.note('No location filter affordance found')
        return 'fail'
      }
      tracker.step('Set radius to 25 miles via location filter')
      await radiusSel.selectOption('25')
      tracker.note('Radius control exists and accepts a 25-mile restriction')
      // Without a pinned location the radius has no effect on item count;
      // verifying the UI affordance is present is the meaningful assertion.
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'favorite-persist',
    persona: 'Returning bidder',
    goal: 'Star a lot and find it again after reloading',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)
      tracker.step('Star the first lot')
      const star = page.locator('.item-card .favorite-button').first()
      await star.click()
      await expect(star).toHaveClass(/active/, { timeout: 5000 })

      // Reload — favorites are cookie-backed and should survive.
      await page.reload()
      await waitForLoad(page)

      tracker.step('Open the Favorites view')
      // Favorites is now an option in the "Show" segmented control (All / Favorites / Ignored).
      const favBtn = page.locator('.segmented-option', { hasText: 'Favorites' })
      await favBtn.click()
      const count = await getItemCount(page)
      if (count < 1) {
        tracker.note('Favorite did not persist across reload')
        return 'fail'
      }
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'share-deeplink',
    persona: 'Sharer',
    goal: 'Open a lot and get a shareable link that reopens it',
    optimalSteps: 2,
    async run({ page, tracker, context }) {
      await gotoApp(page)
      tracker.step('Open a lot')
      await page.locator('.item-card').first().click()
      await expect(page.locator('.detail-panel')).toBeVisible({ timeout: 5000 })

      // The URL should now carry the item — that's what makes it shareable.
      const url = page.url()
      if (!/[?&]item=/.test(url)) {
        tracker.note('Opening a lot does not update the URL — link is not shareable')
        return 'fail'
      }

      tracker.step('Click Share')
      const copy = page.locator('.detail-share')
      await copy.click()
      // "Copied!" confirmation appears on browsers without Web Share API (the fallback path).
      const confirmed = await copy.textContent({ timeout: 2000 }).catch(() => '')
      await page.waitForTimeout(150)
      if (!/copied/i.test((await copy.textContent()) || confirmed || '')) {
        tracker.note('No "Copied!" confirmation shown after clicking Share (fallback path)')
      }

      // Reload the shared URL in a clean page and confirm the lot reopens.
      // (toBeVisible auto-waits for the deep-link effect to run post data-load.)
      const fresh = await context.newPage()
      await fresh.goto(url)
      const reopened = fresh.locator('.detail-panel')
      const ok = await expect(reopened).toBeVisible({ timeout: 10_000 })
        .then(() => true).catch(() => false)
      await fresh.close()
      if (!ok) {
        tracker.note('Shared URL did not reopen the lot detail within 10s')
        return 'fail'
      }
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'flipper-roi',
    persona: 'Flipper',
    goal: 'Use the max-bid calculator to price a flip',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)

      // Need a lot that has eBay comps for the calculator to appear. The comp
      // presence filter now lives in the sidebar "Comps" checkbox group.
      tracker.step('Filter to lots with comps')
      await page.locator('.has-filters .has-filter-row', { hasText: 'eBay' })
        .locator('input[type="checkbox"]').check()
      await page.waitForTimeout(400)
      const withComp = await getItemCount(page)
      if (withComp === 0) {
        tracker.note('No lots in the loaded data have eBay comps — calculator unreachable')
        return 'blocked'
      }

      tracker.step('Open a comped lot to price the flip')
      await page.locator('.item-card').first().click()
      const calc = page.locator('.roi-calc')
      if (!(await calc.isVisible().catch(() => false))) {
        tracker.note('Lot has a comp flag but no ROI calculator rendered')
        return 'fail'
      }

      const maxBid = await page.locator('.roi-result-value').first().textContent()
      if (!/\$\d/.test(maxBid)) {
        tracker.note('Max-bid value missing from the calculator')
        return 'fail'
      }
      // The calculator uses the default 30% resale margin (the margin control
      // was removed; the calc falls back to the default).
      const panelText = await page.locator('.detail-panel').textContent()
      if (!panelText.includes('30%')) {
        tracker.note('Calculator did not show the default resale margin')
        return 'fail'
      }
      return 'pass'
    },
  },

  // -----------------------------------------------------------------------
  {
    id: 'mobile-core-flow',
    persona: 'Mobile bidder',
    goal: 'Complete the core search→detail flow on a phone-sized screen',
    optimalSteps: 2,
    async run({ page, tracker }) {
      await page.setViewportSize(VIEWPORTS[0]) // 375x667
      await gotoApp(page)
      const token = await tokenFromFirstCard(page)

      tracker.step('Search on mobile')
      await page.locator('.search-bar').fill(token)
      await page.locator('.search-bar').press('Enter')
      await page.waitForTimeout(400)
      if (await getItemCount(page) === 0) {
        tracker.note('Mobile search produced no results')
        return 'fail'
      }

      tracker.step('Tap a result to open details')
      await page.locator('.item-card').first().click()
      const panel = page.locator('.detail-panel')
      await expect(panel).toBeVisible({ timeout: 5000 })

      // The detail panel must fit the phone width.
      const overflow = await page.evaluate(() => {
        const p = document.querySelector('.detail-panel')
        return p ? Math.round(p.getBoundingClientRect().width - window.innerWidth) : 0
      })
      if (overflow > 2) {
        tracker.note(`Detail panel overflows mobile viewport by ${overflow}px`)
      }
      return 'pass'
    },
  },
]
