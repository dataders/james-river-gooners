// Shared helpers for the repo's ratchets — one-way quality floors/ceilings whose
// baselines live in scripts/ratchets.json. Every ratchet script imports these so
// each pass/fail line reads the same and a single run reports all violations.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
export const baselines = JSON.parse(
  readFileSync(join(here, 'ratchets.json'), 'utf8')
)

let failed = false

// Discrete count ratchets pass `{ lockIn: true }`: beating the baseline without
// committing the new number FAILS, so gains are locked in immediately and the
// baseline always equals reality (it can only ever move the good way, never
// drift). Continuous metrics (bundle bytes, coverage %) leave it off — those
// fluctuate, so "better than baseline" is fine without an edit.

/** A floor: `current` must stay >= baseline (coverage, typed-file count). */
export function floor(label, current, baseline, unit = '', { lockIn = false } = {}) {
  if (current < baseline) {
    failed = true
    console.error(`❌ ${label}: ${current}${unit} dropped below floor ${baseline}${unit}.`)
  } else if (current > baseline) {
    if (lockIn) {
      failed = true
      console.error(`❌ ${label}: ${current}${unit} beats floor ${baseline}${unit} — lock it in: set the baseline to ${current}${unit}.`)
    } else {
      console.log(`✅ ${label}: ${current}${unit} (floor ${baseline}${unit}) — raise the baseline to lock it in.`)
    }
  } else {
    console.log(`✅ ${label}: ${current}${unit} (at floor ${baseline}${unit}).`)
  }
}

/** A ceiling: `current` must stay <= baseline (untyped files, suppressions, bundle). */
export function ceiling(label, current, baseline, unit = '', { lockIn = false } = {}) {
  if (current > baseline) {
    failed = true
    console.error(`❌ ${label}: ${current}${unit} rose above ceiling ${baseline}${unit}.`)
  } else if (current < baseline) {
    if (lockIn) {
      failed = true
      console.error(`❌ ${label}: ${current}${unit} beats ceiling ${baseline}${unit} — lock it in: set the baseline to ${current}${unit}.`)
    } else {
      console.log(`✅ ${label}: ${current}${unit} (ceiling ${baseline}${unit}) — lower the baseline to lock it in.`)
    }
  } else {
    console.log(`✅ ${label}: ${current}${unit} (at ceiling ${baseline}${unit}).`)
  }
}

/** Exit non-zero if any check failed. Call once at the end of a script. */
export function finish() {
  if (failed) {
    console.error('\nRatchet failed — see ❌ above. Baselines only move the good way; fix the regression or, if intentional, update scripts/ratchets.json.')
    process.exit(1)
  }
}
