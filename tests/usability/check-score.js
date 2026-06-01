/* eslint-disable no-console */
// CI gate for the usability benchmark. Reads the scorecard written by
// `npm run test:usability` and fails (exit 1) if the overall score drops below
// the gate or any bidder objective regressed to a failure.
//
//   node tests/usability/check-score.js
//   USABILITY_GATE=90 node tests/usability/check-score.js
//
// The score floor (default 85) leaves headroom for CI perf variance in the
// latency-based "Fast" dimension while still catching a real regression like a
// big Responsive or Usable drop. A failed objective is always a hard failure.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const GATE = Number(process.env.USABILITY_GATE || 85)
const here = dirname(fileURLToPath(import.meta.url))
const scorecardPath = join(here, 'results', 'scorecard.json')

let data
try {
  data = JSON.parse(readFileSync(scorecardPath, 'utf8'))
} catch (e) {
  console.error(`Could not read scorecard at ${scorecardPath}: ${e.message}`)
  console.error('Did `npm run test:usability` run first?')
  process.exit(2)
}

const { overall, grade, dimensions, counts } = data.scorecard
console.log(`Usability: ${grade} (${overall}/100)  ·  gate ≥ ${GATE}`)
for (const [k, v] of Object.entries(dimensions)) console.log(`  ${k.padEnd(12)} ${v}`)
console.log(`Objectives: ${counts.passed} pass / ${counts.failed} fail / ${counts.blocked} blocked`)

const failures = []
if (overall < GATE) failures.push(`overall ${overall} is below the gate of ${GATE}`)
if (counts.failed > 0) failures.push(`${counts.failed} bidder objective(s) failed`)

if (failures.length) {
  console.error(`\n❌ Usability gate failed: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\n✅ Usability gate passed')
