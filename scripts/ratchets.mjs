#!/usr/bin/env node
// Static source ratchets (no build needed) — run in the type-check CI job.
//
//   - Typed source floor: .ts/.tsx + .js/.jsx with `// @ts-check` can't drop.
//     The TS migration is one-way (a .ts file can't quietly become .js again).
//   - Untyped source ceiling: .js/.jsx without @ts-check can't rise, so new
//     source must be typed — the migration squeezes from both ends.
//   - Suppression ceiling: eslint-disable / @ts-expect-error / @ts-ignore can't
//     proliferate, so coverage isn't "grown" by silencing rules. (`any` itself
//     is held down by the type-aware lint's no-unsafe-* rules.)
//
// Test files (*.test.*, *.vitest.*) and ambient declarations (*.d.ts) are
// excluded so the counts reflect real module migration, not plumbing.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { baselines, floor, ceiling, finish } from './lib-ratchet.mjs'

const SRC = 'src'
const isExcluded = (f) => /\.(test|vitest)\./.test(f) || f.endsWith('.d.ts')
// Unambiguous suppression pragmas only — substring-safe (no prose false matches).
const SUPPRESSION_RE = /eslint-disable|@ts-expect-error|@ts-ignore/g

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let typed = 0
let untyped = 0
let suppressions = 0

for (const f of walk(SRC)) {
  if (isExcluded(f)) continue
  const isTs = f.endsWith('.ts') || f.endsWith('.tsx')
  const isJs = f.endsWith('.js') || f.endsWith('.jsx')
  if (!isTs && !isJs) continue

  const text = readFileSync(f, 'utf8')
  if (isTs) typed++
  else if (text.slice(0, 200).includes('@ts-check')) typed++
  else untyped++

  suppressions += (text.match(SUPPRESSION_RE) || []).length
}

// lockIn: these are exact discrete counts, so beating the baseline must commit
// the new number — the floor/ceiling tightens automatically, never drifts.
floor('Typed source files', typed, baselines.typedSourceFloor, '', { lockIn: true })
ceiling('Untyped source files', untyped, baselines.untypedSourceCeiling, '', { lockIn: true })
ceiling('Lint/type suppressions', suppressions, baselines.suppressionsCeiling, '', { lockIn: true })
finish()
