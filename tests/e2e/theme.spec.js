import { test, expect } from '@playwright/test'

test.describe('Theme toggle', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate first, then clear stored theme and reload so each test starts from
    // the system default. (addInitScript would re-run on every navigation, including
    // reloads inside tests, which breaks the persistence test.)
    await page.goto('/')
    await page.evaluate(() => localStorage.removeItem('gooners-theme'))
    await page.reload()
  })

  test('data-theme attribute is set on html element', async ({ page }) => {
    const theme = await page.locator('html').getAttribute('data-theme')
    expect(['dark', 'light']).toContain(theme)
  })

  test('clicking theme toggle switches theme', async ({ page }) => {
    const html = page.locator('html')
    const before = await html.getAttribute('data-theme')
    await page.locator('button.theme-toggle').click()
    const after = await html.getAttribute('data-theme')
    expect(after).not.toBe(before)
    expect(['dark', 'light']).toContain(after)
  })

  test('theme preference persists across page reload', async ({ page }) => {
    // Click once to set a known theme, then navigate fresh (not reload, which would
    // trigger beforeEach's clear logic on the next test but not this navigation).
    await page.locator('button.theme-toggle').click()
    const saved = await page.locator('html').getAttribute('data-theme')

    // A new goto preserves localStorage (no addInitScript registered)
    await page.goto('/')
    const after = await page.locator('html').getAttribute('data-theme')
    expect(after).toBe(saved)
  })

  test('theme toggle aria-label reflects current theme', async ({ page }) => {
    const btn = page.locator('button.theme-toggle')
    const label = await btn.getAttribute('aria-label')
    expect(label).toMatch(/Switch to (light|dark) mode/)
  })

  test('aria-label updates after toggle', async ({ page }) => {
    const btn = page.locator('button.theme-toggle')
    const before = await btn.getAttribute('aria-label')
    await btn.click()
    const after = await btn.getAttribute('aria-label')
    expect(after).not.toBe(before)
    expect(after).toMatch(/Switch to (light|dark) mode/)
  })
})
