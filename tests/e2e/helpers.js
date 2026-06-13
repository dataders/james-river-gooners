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

// Drag a range slider thumb to a specific position (0–200) with a real pointer
// gesture — the Radix slider has no native <input>, so its thumbs only move on
// pointer/keyboard events. `sliderClass` keeps the old `.range-slider-lo` /
// `.range-slider-hi` call sites working by mapping to the lo/hi Radix thumb. The
// filter is located by label text (e.g. "Bids", "Ends within") anchored at the
// start so "Bids" never matches "Bidders"; the Bidders slider renders only when
// bidder data is present, so positional indices would otherwise shift.
export async function setRangeValue(page, filterLabel, sliderClass, position) {
  const isLo = sliderClass.includes('lo')
  const labelRe = new RegExp('^' + filterLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const filter = page.locator('.range-filter').filter({ hasText: labelRe }).first()
  const thumb = filter.locator(isLo ? '.range-slider-thumb-lo' : '.range-slider-thumb-hi')
  const track = filter.locator('.range-slider-track')

  await thumb.scrollIntoViewIfNeeded()
  const tb = await track.boundingBox()
  const startBox = await thumb.boundingBox()
  if (!tb || !startBox) throw new Error(`Slider thumb for "${filterLabel}" not found`)

  // Map slider position (0–200 = SLIDER_STEPS) to an x along the track.
  const ratio = Math.max(0, Math.min(1, position / 200))
  const targetX = tb.x + ratio * tb.width
  const cy = startBox.y + startBox.height / 2

  await page.mouse.move(startBox.x + startBox.width / 2, cy)
  await page.mouse.down()
  await page.mouse.move(targetX, cy, { steps: 8 })
  await page.mouse.up()
}

// Click an "Ends within" preset (1 day / 1 week / All) — the segmented control
// that replaced the hours slider.
export async function selectEndsWithin(page, label) {
  await page.getByRole('group', { name: 'Ends within' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

// Read the "Any" / "≤ X" / "X – Y" summary text for a range filter, located by
// its label text.
export async function getRangeSummary(page, filterLabel) {
  return page.locator('.range-filter', { has: page.locator('.range-label', { hasText: filterLabel }) })
    .locator('.range-value')
    .first()
    .textContent()
}
