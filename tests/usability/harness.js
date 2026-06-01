// Shared instrumentation for the usability benchmark.
//
// The benchmark drives the live app the way a bidder would and records how much
// *friction* each task involves: did it complete, how many interaction steps it
// took versus the optimal path, how long it took, and any rough edges hit along
// the way. The numbers feed a scorecard (see report.js) graded on the four goals
// for this site: usable, intuitive, responsive, fast.

import { expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Per-task instrumentation
// ---------------------------------------------------------------------------

// A tracker counts the discrete UI interactions a task needs (clicks, key
// presses, typed queries) and collects friction notes — anything that would
// make a real user hesitate or backtrack.
export function createTracker() {
  const steps = []
  const friction = []
  return {
    steps,
    friction,
    // Record one interaction. `label` is human-readable for the report.
    step(label) {
      steps.push(label)
    },
    // Record a usability rough edge discovered during the task.
    note(label) {
      friction.push(label)
    },
    get count() {
      return steps.length
    },
  }
}

// ---------------------------------------------------------------------------
// App navigation helpers
// ---------------------------------------------------------------------------

// Navigate to the app (optionally with query string) and wait for the data
// pipeline to finish. Returns the measured data-ready time in ms.
export async function gotoApp(page, query = '') {
  const start = Date.now()
  await page.goto('/' + query)
  await waitForLoad(page)
  return Date.now() - start
}

// Wait until the Parquet/ndjson load finishes and the grid is populated.
export async function waitForLoad(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
  await expect(page.locator('.item-count').first()).toBeVisible({ timeout: 20_000 })
}

// Read the "<n> items" count from the grid header.
export async function getItemCount(page) {
  const text = await page.locator('.item-count').first().textContent()
  const match = text?.match(/(\d[\d,]*)\s+items/)
  return match ? parseInt(match[1].replace(/,/g, ''), 10) : 0
}

// ---------------------------------------------------------------------------
// Performance probes
// ---------------------------------------------------------------------------

// Collect browser-reported load timings on a freshly loaded page.
export async function collectPerf(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {}
    const paint = performance.getEntriesByType('paint')
    const fcp = paint.find(p => p.name === 'first-contentful-paint')
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      loadComplete: Math.round(nav.loadEventEnd || 0),
      firstContentfulPaint: fcp ? Math.round(fcp.startTime) : null,
      transferKB: nav.transferSize ? Math.round(nav.transferSize / 1024) : null,
    }
  })
}

// Time how long the grid takes to settle after an interaction that changes the
// result set (typing a search, toggling a filter). We poll the item-count text
// and measure when it stops changing.
export async function measureSettle(page, action) {
  const before = await getItemCount(page)
  const start = Date.now()
  await action()
  // Wait for the count to change OR for it to hold steady for 250ms.
  let last = before
  let stableSince = Date.now()
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const now = await getItemCount(page)
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (now !== before && Date.now() - stableSince > 120) {
      break
    } else if (Date.now() - stableSince > 400) {
      break // count never changed (already-correct result) — treat as settled
    }
    await page.waitForTimeout(20)
  }
  return Date.now() - start
}

// ---------------------------------------------------------------------------
// Accessibility probes (dependency-free, runs in the page)
// ---------------------------------------------------------------------------

// Lightweight a11y audit: accessible names on interactive elements, alt text on
// images, heading structure, and a contrast spot-check on body text. This is a
// pragmatic subset of what axe-core checks — enough to flag the common issues
// without pulling a heavy dependency into the build.
export async function auditAccessibility(page) {
  return page.evaluate(() => {
    const issues = []

    // 1. Interactive controls must have an accessible name.
    const interactive = [...document.querySelectorAll('button, a[href], [role="button"]')]
    let unnamed = 0
    for (const el of interactive) {
      if (el.offsetParent === null) continue // skip hidden
      const name = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent ||
        ''
      ).trim()
      if (!name) unnamed++
    }
    if (unnamed > 0) issues.push(`${unnamed} interactive element(s) without an accessible name`)

    // 2. Content images must have alt text (decorative ones use alt="").
    const imgs = [...document.querySelectorAll('img')]
    const missingAlt = imgs.filter(i => i.offsetParent !== null && i.getAttribute('alt') === null).length
    if (missingAlt > 0) issues.push(`${missingAlt} image(s) missing an alt attribute`)

    // 3. Exactly one <h1> for the page landmark.
    const h1s = document.querySelectorAll('h1').length
    if (h1s !== 1) issues.push(`expected exactly one <h1>, found ${h1s}`)

    // 4. Body-text contrast spot check on item titles.
    function luminance(rgb) {
      const [r, g, b] = rgb.map(v => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    function parseRGB(str) {
      const m = str.match(/rg?b?a?\(([^)]+)\)/)
      if (!m) return null
      return m[1].split(',').slice(0, 3).map(n => parseFloat(n))
    }
    const sample = document.querySelector('.item-title')
    let contrast = null
    if (sample) {
      const fg = parseRGB(getComputedStyle(sample).color)
      // Walk up for the first non-transparent background.
      let node = sample
      let bg = null
      while (node && !bg) {
        const c = parseRGB(getComputedStyle(node).backgroundColor)
        const alpha = getComputedStyle(node).backgroundColor.includes('rgba')
          ? parseFloat(getComputedStyle(node).backgroundColor.split(',')[3])
          : 1
        if (c && alpha > 0) bg = c
        node = node.parentElement
      }
      if (fg && bg) {
        const l1 = luminance(fg) + 0.05
        const l2 = luminance(bg) + 0.05
        contrast = Math.round((Math.max(l1, l2) / Math.min(l1, l2)) * 100) / 100
        if (contrast < 4.5) issues.push(`item-title contrast ratio ${contrast}:1 is below WCAG AA (4.5:1)`)
      }
    }

    return {
      interactiveCount: interactive.length,
      imageCount: imgs.length,
      headingCount: document.querySelectorAll('h1,h2,h3').length,
      bodyContrast: contrast,
      issues,
    }
  })
}

// ---------------------------------------------------------------------------
// Responsive probes
// ---------------------------------------------------------------------------

export const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]

// Check a single viewport for the common responsive failures: horizontal
// overflow, undersized tap targets on primary controls, and that the grid
// actually renders cards.
export async function auditViewport(page) {
  return page.evaluate(() => {
    const checks = []
    const pass = (name, ok, detail) => checks.push({ name, ok, detail })

    // No horizontal scroll — the #1 mobile-layout smell. 2px tolerance for
    // sub-pixel rounding.
    const overflow = document.documentElement.scrollWidth - window.innerWidth
    pass('no-horizontal-overflow', overflow <= 2, `${overflow}px overflow`)

    // Primary controls should meet a ~44px touch target (we allow 36px as a
    // lenient floor for dense desktop chrome).
    const targets = [
      ['search', '.search-bar'],
      ['theme-toggle', '.theme-toggle'],
      ['help', '.help-button'],
      ['categories', '.filter-bar-toggle'],
    ]
    for (const [label, sel] of targets) {
      const el = document.querySelector(sel)
      if (!el) { pass(`tap-${label}`, false, 'not found'); continue }
      const r = el.getBoundingClientRect()
      const ok = r.height >= 36 && r.width >= 36
      pass(`tap-${label}`, ok, `${Math.round(r.width)}x${Math.round(r.height)}`)
    }

    // Grid renders at least one card and cards fit within the viewport.
    const cards = document.querySelectorAll('.item-card')
    pass('grid-renders', cards.length > 0, `${cards.length} cards`)
    if (cards.length > 0) {
      const r = cards[0].getBoundingClientRect()
      pass('card-fits-width', r.width <= window.innerWidth + 2, `${Math.round(r.width)}px wide`)
    }

    return checks
  })
}
