#!/usr/bin/env node
// Supabase advisor ratchet.
//
// Fails if the live project gains a NEW security or performance advisor finding
// that isn't in scripts/supabase-advisors-baseline.json. It tracks finding
// IDENTITY (each lint's stable `cache_key`), not just a count, so a regression
// can't hide behind an unrelated fix (one resolved + one new = net zero count,
// but a real new risk). Resolved findings are reported so you can prune the
// baseline and lock the fix in.
//
// Reads the Management API with SUPABASE_ACCESS_TOKEN (a PAT, sbp_…). The
// workflow skips cleanly when that secret is absent, so this is inert until the
// token is configured — see CLAUDE.md → Environment variables.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT_REF = 'cjvllfqldyzsnsjiucks'
const TYPES = ['security', 'performance']

const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token) {
  console.error('SUPABASE_ACCESS_TOKEN not set — cannot read advisors.')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(
  readFileSync(join(here, 'supabase-advisors-baseline.json'), 'utf8')
)

async function fetchKeys(type) {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/advisors/${type}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) {
    throw new Error(`advisors/${type}: HTTP ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return (data.lints || []).map((l) => l.cache_key)
}

let failed = false

for (const type of TYPES) {
  const current = new Set(await fetchKeys(type))
  const base = new Set(baseline[type] || [])
  const added = [...current].filter((k) => !base.has(k))
  const resolved = [...base].filter((k) => !current.has(k))

  if (added.length) {
    failed = true
    console.error(`❌ ${type}: ${added.length} new advisor finding(s):`)
    for (const k of added) console.error(`   + ${k}`)
  } else {
    console.log(`✅ ${type}: no new findings (${current.size} live, baseline ${base.size}).`)
  }
  if (resolved.length) {
    console.log(`   ${resolved.length} ${type} finding(s) resolved — prune from the baseline to lock in:`)
    for (const k of resolved) console.log(`   - ${k}`)
  }
}

if (failed) {
  console.error(
    '\nAdvisor ratchet failed — the live DB gained a security/perf finding. Fix it, or if intentional add its cache_key to scripts/supabase-advisors-baseline.json.'
  )
  process.exit(1)
}
