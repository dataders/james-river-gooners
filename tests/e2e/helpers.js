import { expect } from '@playwright/test'

// Wait for the FULL Supabase data load to finish.
//
// The grid renders progressively: `.loading` hides as soon as the first page
// paints, but the rest of the ~6.5K-row set is still streaming in from the slow
// free-tier DB, so the item count isn't yet stable. Tests assert exact counts,
// so we wait for `main[data-load-complete="true"]` (the useAuctionData
// `loadComplete` flag), which also implies the spinner is gone.
//
// The full load is slow (and parallel CI workers add contention), so the window
// is generous; reload once if it stalls or errored (Vite cold-start, free-tier
// wake-up). CI retries (retries: 1) cover the rare case where even a reload
// runs past the test timeout.
export async function waitForLoad(page) {
  const ready = await page.locator('main[data-load-complete="true"]')
    .waitFor({ state: 'visible', timeout: 70_000 }).then(() => true).catch(() => false)
  if (!ready || await page.locator('.error').isVisible()) {
    await page.reload()
    await expect(page.locator('main[data-load-complete="true"]')).toBeVisible({ timeout: 70_000 })
  }
  await expect(page.locator('.error')).toBeHidden()
}

// Open the item-detail modal for a card that has eBay comp data (the ROI row).
//
// Comp data streams in per-auction *after* the initial item load, and each batch
// re-flows the masonry grid. A fixed `waitForTimeout` followed by a single click
// races that reflow: the card node Playwright resolved can be re-mounted between
// click and React's onClick, so the click is swallowed and the modal never opens.
// Instead we (1) wait for a comp card to actually appear rather than guessing a
// delay, (2) let the per-auction comp fetches go idle so the grid stops
// re-flowing, and (3) click-and-verify with a retry so a swallowed click is
// retried instead of failing the test.
//
// Returns true once the modal is open, or false if no comp data loaded (the
// caller should `test.skip` in that case).
export async function openRoiCard(page) {
  const cards = page.locator('.item-card:has(.item-roi-row)')
  try {
    await cards.first().waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    return false
  }
  // Bounded: comp fetches normally settle quickly; don't hang the test if some
  // background request (lazy image, etc.) keeps the network busy.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})

  const card = cards.first()
  await card.scrollIntoViewIfNeeded()
  await expect(async () => {
    await card.click()
    await expect(page.locator('.detail-overlay')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  return true
}

// Open the detail modal for the lot at logical grid index `i`. The grid is
// window-virtualized (TanStack Virtual), so only a window of cells is in the
// DOM at once — scroll the page until the cell with that data-index mounts,
// then click its card. Returns false if the index never appears.
export async function openCardByIndex(page, i) {
  for (let tries = 0; tries < 40; tries++) {
    const cell = page.locator(`.virtual-grid-cell[data-index="${i}"]`)
    if (await cell.count()) {
      await cell.scrollIntoViewIfNeeded()
      await cell.locator('.item-card').click()
      return true
    }
    await page.mouse.wheel(0, 1400)
    await page.waitForTimeout(100)
  }
  return false
}

// Select a view from the segmented archive "Auctions" control (Active / All /
// Archived). Replaced the old "Archived auctions" checkbox in the three-state
// archive filter.
export async function selectArchiveView(page, name) {
  await page.getByRole('group', { name: 'Which auctions to show' })
    .getByRole('button', { name, exact: true })
    .click()
}

// Read the visible item count from the grid header
export async function getItemCount(page) {
  const text = await page.locator('.item-count').textContent()
  const match = text?.match(/^(\d+) items/)
  return match ? parseInt(match[1], 10) : 0
}

// Set a range slider to a specific position (0–200) via native value setter so
// React's synthetic onChange fires correctly on the input event. The filter is
// located by its label text (e.g. "Bids", "Ends within") rather than a fixed
// index, since the Bidders slider renders only when bidder data is present and
// would otherwise shift positional indices.
export async function setRangeValue(page, filterLabel, sliderClass, position) {
  await page.evaluate(({ label, cls, pos }) => {
    const filters = [...document.querySelectorAll('.range-filter')]
    const filter = filters.find(f =>
      f.querySelector('.range-label')?.textContent?.trim().startsWith(label)
    )
    if (!filter) throw new Error(`Range filter labelled "${label}" not found`)
    const slider = filter.querySelector(cls)
    if (!slider) throw new Error(`Slider ${cls} not found in "${label}" filter`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(slider, String(pos))
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  }, { label: filterLabel, cls: sliderClass, pos: position })
}

// Read the "Any" / "≤ X" / "X – Y" summary text for a range filter, located by
// its label text.
export async function getRangeSummary(page, filterLabel) {
  return page.locator('.range-filter', { has: page.locator('.range-label', { hasText: filterLabel }) })
    .locator('.range-value')
    .first()
    .textContent()
}
