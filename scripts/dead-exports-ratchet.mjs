#!/usr/bin/env node
// Dead-exports ratchet: run knip and count unused exports across the src/ tree.
// The count can only go down — removing a dead export lowers the ceiling and
// the new number must be locked in. knip.json configures the scope: auto-
// generated files (database.types.ts) and Deno edge functions (supabase/functions/)
// are excluded because knip can't resolve their import contexts.

import { execSync } from 'node:child_process'
import { baselines, ceiling, finish } from './lib-ratchet.mjs'

// knip exits 1 when it finds issues, so we must capture stdout on failure too.
let report
try {
  const out = execSync('npx knip --include exports --reporter json 2>/dev/null', { encoding: 'utf8' })
  report = JSON.parse(out || '{"issues":[]}')
} catch (err) {
  const stdout = /** @type {{stdout?: string}} */ (err).stdout ?? ''
  report = JSON.parse(stdout || '{"issues":[]}')
}

const count = (report.issues ?? []).reduce(
  (sum, file) => sum + (file.exports?.length ?? 0),
  0,
)

ceiling('Dead exports', count, baselines.deadExportsCeiling, '', { lockIn: true })
finish()
