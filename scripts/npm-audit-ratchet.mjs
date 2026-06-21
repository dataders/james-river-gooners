#!/usr/bin/env node
// npm audit ratchet: existing advisories are tracked explicitly so dependency
// risk cannot grow quietly while upstream fixes are not yet available in the
// current dependency graph.

import { execSync } from 'node:child_process'
import { baselines, ceiling, finish } from './lib-ratchet.mjs'

let audit
try {
  audit = execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (err) {
  audit = /** @type {{stdout?: string}} */ (err).stdout ?? ''
}

if (!audit) {
  console.error('npm audit did not return JSON output.')
  process.exit(1)
}

let report
try {
  report = JSON.parse(audit)
} catch (err) {
  console.error('npm audit returned invalid JSON.')
  console.error(err)
  process.exit(1)
}

if (!report.metadata?.vulnerabilities) {
  console.error('npm audit JSON is missing metadata.vulnerabilities.')
  process.exit(1)
}

const vulnerabilities = report.metadata?.vulnerabilities ?? {}
const highCritical = (vulnerabilities.high ?? 0) + (vulnerabilities.critical ?? 0)
const total = vulnerabilities.total ?? 0

ceiling(
  'npm audit high+critical advisories',
  highCritical,
  baselines.npmAuditHighCriticalCeiling,
  '',
  { lockIn: true },
)
ceiling('npm audit total advisories', total, baselines.npmAuditTotalCeiling, '', {
  lockIn: true,
})
finish()
