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
