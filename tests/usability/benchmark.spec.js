// Usability benchmark runner.
//
// Runs each bidder objective, plus global performance / responsive /
// accessibility probes, then writes a scored report to:
//   tests/usability/results/REPORT.md
//   tests/usability/results/scorecard.json
//
// Run with:  npm run test:usability
//
// Serial mode keeps everything in one worker so results accumulate into a single
// report. Objective assertions are recorded as data rather than hard failures,
// so the report always generates even when a task surfaces a problem.

import { test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { objectives } from './objectives.js'
import {
  gotoApp,
  collectPerf,
  measureSettle,
  auditAccessibility,
  auditViewport,
  VIEWPORTS,
} from './harness.js'
import { writeReport, buildScorecard } from './report.js'

const here = dirname(fileURLToPath(import.meta.url))
const RESULTS_MD = join(here, 'results', 'REPORT.md')
const RESULTS_JSON = join(here, 'results', 'scorecard.json')

const results = {
  objectives: [],
  perf: {},
  responsive: [],
  a11y: null,
  consoleErrors: [],
}

test.describe.configure({ mode: 'serial' })

test.describe('Usability benchmark', () => {
  // ---- One test per bidder objective --------------------------------------
  for (const obj of objectives) {
    test(`[objective] ${obj.persona} — ${obj.goal}`, async ({ page, context }) => {
      const errors = []
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
      page.on('pageerror', e => errors.push(e.message))

      const tracker = { steps: [], friction: [], step(l) { this.steps.push(l) }, note(l) { this.friction.push(l) } }
      const start = Date.now()
      let status = 'fail'
      try {
        status = await obj.run({ page, tracker, context })
      } catch (e) {
        tracker.friction.push(`Threw: ${e.message.split('\n')[0]}`)
        status = 'fail'
      }
      results.objectives.push({
        id: obj.id,
        persona: obj.persona,
        goal: obj.goal,
        status,
        steps: tracker.steps.length,
        optimalSteps: obj.optimalSteps,
        durationMs: Date.now() - start,
        friction: tracker.friction,
      })
      results.consoleErrors.push(...errors)
    })
  }

  // ---- Global performance probe -------------------------------------------
  test('[metrics] performance', async ({ page }) => {
    const dataReadyMs = await gotoApp(page)
    const perf = await collectPerf(page)

    // Interaction latencies on a warm page.
    const token = await page.locator('.item-card .item-title').first().textContent()
      .then(t => (t || 'table').split(/\s+/).find(w => w.replace(/[^a-z]/gi, '').length >= 4) || 'table')
    const searchLatencyMs = await measureSettle(page, () => page.locator('.search-bar').fill(token))
    await page.locator('.search-clear').click().catch(() => {})
    await page.waitForTimeout(300)

    await page.locator('.filter-bar-toggle').click()
    await page.locator('.filter-group-toggle').first().click()
    const filterLatencyMs = await measureSettle(page, async () => {
      await page.locator('.filter-group-body .filter-chip').first().click()
    })

    results.perf = { dataReadyMs, ...perf, searchLatencyMs, filterLatencyMs }
  })

  // ---- Responsive probe across viewports ----------------------------------
  test('[metrics] responsive layout', async ({ page }) => {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await gotoApp(page)
      await page.waitForTimeout(300)
      const checks = await auditViewport(page)
      results.responsive.push({ viewport: vp.name, checks })
    }
  })

  // ---- Accessibility probe -------------------------------------------------
  test('[metrics] accessibility', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await gotoApp(page)
    results.a11y = await auditAccessibility(page)
  })

  // ---- Write the report ----------------------------------------------------
  test.afterAll(async () => {
    const card = writeReport(results, RESULTS_MD, RESULTS_JSON)
    // Surface the headline in the test runner output.
    console.log('\n===== USABILITY SCORECARD =====')
    console.log(`Overall: ${card.grade} (${card.overall}/100)`)
    for (const [k, v] of Object.entries(card.dimensions)) console.log(`  ${k.padEnd(12)} ${v}`)
    console.log(`Objectives: ${card.counts.passed} pass / ${card.counts.failed} fail / ${card.counts.blocked} blocked`)
    console.log(`Report: ${RESULTS_MD}`)
    console.log('================================\n')
  })
})

export { buildScorecard }
