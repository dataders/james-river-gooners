#!/usr/bin/env node
// Bundle-size ratchet — run in the build CI job after `npm run build`.
//
// Sums the gzipped size of the production JS chunks and fails if it rises past
// the budget. This SPA is bundle-conscious (the _card views halve the data
// payload; valibot was chosen for being tree-shakeable) — this catches a
// mis-imported heavy dependency before it ships. Bump the ceiling deliberately
// when a feature legitimately grows the bundle.

import { readdirSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { baselines, ceiling, finish } from './lib-ratchet.mjs'

const DIR = 'dist/assets'

let files
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.js'))
} catch {
  console.error(`bundle-size: ${DIR} not found — run \`npm run build\` first.`)
  process.exit(1)
}
if (files.length === 0) {
  console.error(`bundle-size: no JS chunks in ${DIR} — did the build succeed?`)
  process.exit(1)
}

let total = 0
for (const f of files) {
  total += gzipSync(readFileSync(join(DIR, f))).length
}

ceiling('Bundle JS (gzip)', total, baselines.bundleGzipBytesCeiling, ' B')
finish()
