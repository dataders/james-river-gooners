#!/usr/bin/env node
// TypeScript migration ratchet.
//
// Counts the typed *source* files under src/ — `.ts`/`.tsx`, plus `.js`/`.jsx`
// that opt in with `// @ts-check` — and fails if that number drops below the
// baseline. The migration is one-way: this stops a `.ts` file from quietly
// reverting to `.js`, or a `@ts-check` pragma from being deleted, eroding the
// coverage that `npm run type-check` enforces.
//
// Test files (*.test.*, *.vitest.*) and ambient declarations (*.d.ts) are
// excluded so the number reflects real module migration, not test plumbing.
//
// When you migrate more files the count rises above the baseline and the script
// reminds you to bump BASELINE here — that's how progress gets locked in.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The migration floor. Only ever goes UP. Bump it when you add typed files.
const BASELINE = 19

const SRC = 'src'
const isExcluded = (f) => /\.(test|vitest)\./.test(f) || f.endsWith('.d.ts')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let count = 0
const typed = []
for (const f of walk(SRC)) {
  if (isExcluded(f)) continue
  if (f.endsWith('.ts') || f.endsWith('.tsx')) {
    count++
    typed.push(f)
  } else if (f.endsWith('.js') || f.endsWith('.jsx')) {
    if (readFileSync(f, 'utf8').slice(0, 200).includes('@ts-check')) {
      count++
      typed.push(f)
    }
  }
}

if (count < BASELINE) {
  console.error(
    `❌ TypeScript coverage dropped to ${count} typed source files; baseline is ${BASELINE}.`
  )
  console.error(
    '   The migration is one-way — restore the .ts file or @ts-check pragma you removed.'
  )
  process.exit(1)
}

if (count > BASELINE) {
  console.log(
    `✅ ${count} typed source files (baseline ${BASELINE}). ` +
      `Lock it in: set BASELINE to ${count} in scripts/ts-ratchet.mjs.`
  )
} else {
  console.log(`✅ ${count} typed source files (at baseline ${BASELINE}).`)
}
