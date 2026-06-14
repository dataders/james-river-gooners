#!/usr/bin/env node
// Coverage ratchet — runs the unit suite with Node's built-in coverage
// thresholds (node >=22.13). Fails if line/branch/function coverage of the
// test-exercised files drops below the floors in scripts/ratchets.json.
// Replaces the plain `test:unit:coverage`; raise the floors as coverage climbs.

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { baselines } from './lib-ratchet.mjs'

const { lines, branches, functions } = baselines.coverage
const dir = 'src/utils'
const tests = readdirSync(dir)
  .filter((f) => /\.test\.(js|ts)$/.test(f))
  .map((f) => `${dir}/${f}`)

console.log(
  `coverage ratchet: floors lines≥${lines}% branches≥${branches}% functions≥${functions}%`
)

const result = spawnSync(
  process.execPath,
  [
    '--test',
    '--experimental-test-coverage',
    `--test-coverage-lines=${lines}`,
    `--test-coverage-branches=${branches}`,
    `--test-coverage-functions=${functions}`,
    ...tests,
  ],
  { stdio: 'inherit' }
)

process.exit(result.status ?? 1)
