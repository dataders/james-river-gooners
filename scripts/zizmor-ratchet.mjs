#!/usr/bin/env node
// GitHub Actions security ratchet. Offline zizmor audits keep CI deterministic:
// online audits need a token and can drift as the remote action ecosystem moves.

import { execSync } from 'node:child_process'
import { baselines, ceiling, finish } from './lib-ratchet.mjs'

const cmd = [
  'uvx zizmor@1.14.2',
  '.github/workflows',
  '--format json',
  '--no-exit-codes',
  '--no-online-audits',
  '--no-progress',
  '--min-severity high',
  '--min-confidence high',
].join(' ')

const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const findings = JSON.parse(out || '[]')
const counts = new Map()
for (const finding of findings) {
  counts.set(finding.ident, (counts.get(finding.ident) ?? 0) + 1)
}

for (const [ident, count] of [...counts.entries()].sort()) {
  console.log(`zizmor ${ident}: ${count}`)
}

ceiling(
  'zizmor high-confidence/high-severity findings',
  findings.length,
  baselines.zizmorHighConfidenceHighSeverityCeiling,
  '',
  { lockIn: true },
)
finish()
