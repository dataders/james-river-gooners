import { expect } from '@playwright/test'

// Wait for the ndjson data pipeline to finish.
// Reloads once if data loading errored — handles Vite dev-server cold-start on CI
// where the first fetch can fail before the server has fully initialised.
export async function waitForLoad(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
  if (await page.locator('.error').isVisible()) {
    await page.reload()
    await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
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

// Read the visible item count from the grid header
export async function getItemCount(page) {
  const text = await page.locator('.item-count').textContent()
  const match = text?.match(/^(\d+) items/)
  return match ? parseInt(match[1], 10) : 0
}

// Set a range slider to a specific position (0–200) via native value setter so
// React's synthetic onChange fires correctly on the input event.
export async function setRangeValue(page, filterIndex, sliderClass, position) {
  await page.evaluate(({ idx, cls, pos }) => {
    const filters = document.querySelectorAll('.range-filter')
    const filter = filters[idx]
    const slider = filter?.querySelector(cls)
    if (!slider) throw new Error(`Slider ${cls} not found in range-filter[${idx}]`)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(slider, String(pos))
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  }, { idx: filterIndex, cls: sliderClass, pos: position })
}
