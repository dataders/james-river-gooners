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
      tracker.step('Lower the max-price slider')
      const latency = await measureSettle(page, async () => {
        await page.evaluate(() => {
          const filter = document.querySelectorAll('.range-filter')[0]
          const slider = filter?.querySelectorAll('input[type="range"]')[1]
          if (!slider) throw new Error('price max slider not found')
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(slider, '60') // ~30% along a log scale → a low price cap
          slider.dispatchEvent(new Event('input', { bubbles: true }))
        })
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
    optimalSteps: 2,
    async run({ page, tracker }) {
      await gotoApp(page)

      tracker.step('Open Categories panel')
      await page.locator('.filter-bar-toggle').click()
      await expect(page.locator('.filter-bar-body')).toBeVisible({ timeout: 5000 })

      // To see only one category you must hide everything then re-show one.
      tracker.step('Hide all categories')
      const hideAll = page.locator('.filter-bar .filter-action', { hasText: 'hide all' })
      if (!(await hideAll.count())) {
        tracker.note('No "hide all" shortcut available')
        return 'fail'
      }
      await hideAll.first().click()

      tracker.step('Expand first category group')
      const group = page.locator('.filter-group-toggle').first()
      await group.click()
      const showChip = page.locator('.filter-group-body .filter-chip').first()
      await expect(showChip).toBeVisible({ timeout: 5000 })

      tracker.step('Re-show one category')
      const latency = await measureSettle(page, async () => {
        await showChip.click()
      })
      tracker.note(`Category toggle settled in ${latency}ms`)
      tracker.note('No one-click "only this category" — requires hide-all then re-show (4 steps)')
      const count = await getItemCount(page)
      return count > 0 ? 'pass' : 'fail'
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
      const total = await getItemCount(page)
      const toggle = page.locator('.local-toggle', { hasText: 'Richmond' }).locator('input')
      if (!(await toggle.count())) {
        tracker.note('No Richmond-area filter found')
        return 'fail'
      }
      tracker.step('Check "Richmond area only"')
      const latency = await measureSettle(page, async () => {
        await toggle.check()
      })
      tracker.note(`Locality filter settled in ${latency}ms`)
      const local = await getItemCount(page)
      // Either it narrowed, or everything already was local — both are valid.
      if (local === 0) {
        tracker.note('Richmond-only produced 0 items')
        return 'fail'
      }
      if (local === total) {
        tracker.note('All loaded auctions are already local; filter had no visible effect')
      }
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
      await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })

      tracker.step('Open the Favorites view')
      const favBtn = page.locator('.deals-toggle', { hasText: 'Favorites' })
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

      tracker.step('Click "Copy link"')
      const copy = page.locator('.detail-copy-link')
      await copy.click()
      // "Copied!" confirmation is a nice-to-have; URL state is the real test.
      const confirmed = await copy.textContent({ timeout: 2000 }).catch(() => '')
      await page.waitForTimeout(150)
      if (!/copied/i.test((await copy.textContent()) || confirmed || '')) {
        tracker.note('No "Copied!" confirmation shown after clicking Copy link')
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
    goal: 'Use the max-bid calculator to price a flip with a target margin',
    optimalSteps: 3,
    async run({ page, tracker }) {
      await gotoApp(page)

      // Need a lot that has eBay comps for the calculator to appear.
      tracker.step('Filter to lots with comps')
      await page.locator('.deals-toggle', { hasText: 'Has comp' }).click()
      await page.waitForTimeout(400)
      const withComp = await getItemCount(page)
      if (withComp === 0) {
        tracker.note('No lots in the loaded data have eBay comps — calculator unreachable')
        return 'blocked'
      }

      tracker.step('Open a comped lot')
      await page.locator('.item-card').first().click()
      const calc = page.locator('.roi-calc')
      if (!(await calc.isVisible().catch(() => false))) {
        tracker.note('Lot has a comp flag but no ROI calculator rendered')
        return 'fail'
      }

      const before = await page.locator('.roi-result-value').first().textContent()
      tracker.step('Adjust the target-margin slider')
      await page.evaluate(() => {
        const slider = document.querySelector('.roi-margin-slider')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(slider, '40')
        slider.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await page.waitForTimeout(200)
      const after = await page.locator('.roi-result-value').first().textContent()
      if (before === after) {
        tracker.note('Max-bid value did not respond to margin change')
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
