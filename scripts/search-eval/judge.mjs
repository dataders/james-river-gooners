#!/usr/bin/env node
/**
 * Generate relevance judgments with an LLM judge (Claude Haiku).
 *
 * For each query it pools the top-K from the current search config (the path we
 * want to measure) PLUS any hand-seeded known-relevant lots (so recall misses
 * for items the search *fails* to surface are still measured — avoids pooling
 * bias), then asks the judge to grade each (query, lot) pair on a 0/1/2 scale.
 * Writes judgments.jsonl. Validate the output against a hand-labeled sample
 * before trusting it (see README); humans remain the final arbiter.
 *
 *   ANTHROPIC_API_KEY=… SUPABASE_URL=… VITE_SUPABASE_PUBLISHABLE_KEY=… \
 *     node scripts/search-eval/judge.mjs [--k 15]
 */
import { pipeline, env } from '@huggingface/transformers'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

env.allowLocalModels = false
const DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(DIR, '../..')
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SECRET_KEY
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY
const MODEL = 'claude-haiku-4-5'
const K = process.argv.includes('--k') ? Number(process.argv[process.argv.indexOf('--k') + 1]) : 15

if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
  console.error('Need SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, ANTHROPIC_API_KEY.')
  process.exit(2)
}

// Known-relevant lots that exist in the corpus — seeded by hand so the benchmark
// measures recall even when the search fails to surface them in the top-K.
let SEEDS = {}
try { SEEDS = JSON.parse(fs.readFileSync(path.join(DIR, 'seeds.json'), 'utf8')) } catch { /* optional */ }

const key = (s, i) => `${s}:${i}`

// lot text from the local NDJSON read model (the eval corpus snapshot)
function loadCorpusText() {
  const dir = path.join(ROOT, 'public/data/items')
  const meta = new Map()
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ndjson'))) {
    const sid = f.slice(0, -7)
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const d = JSON.parse(line)
      meta.set(key(sid, d.id), { title: d.title || '', desc: (d.description || '').slice(0, 400) })
    }
  }
  return meta
}

let extractor = null
async function embed(query) {
  if (!extractor) extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: 'q8' })
  const out = await extractor(`search_query: ${query}`, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}
async function search(query, k) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_lots_eval`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: await embed(query), match_count: k }),
  })
  if (!resp.ok) throw new Error(`match_lots_eval ${resp.status}`)
  return (await resp.json()).map(r => key(r.auction_safe_id, r.item_id))
}

async function grade(query, title, desc) {
  const prompt = `You grade search relevance for an online auction site. A user searched for a lot to buy.

Query: "${query}"
Lot title: "${title}"
Lot description: "${desc}"

Grade how well this lot matches what the searcher wants:
2 = highly relevant (this is clearly the kind of item they searched for)
1 = somewhat related (same broad category or a near-substitute)
0 = not relevant

Reply with ONLY the single digit 0, 1, or 2.`
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 5, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!resp.ok) throw new Error(`anthropic ${resp.status}: ${await resp.text()}`)
  const txt = (await resp.json()).content[0].text.trim()
  const m = txt.match(/[012]/)
  return m ? Number(m[0]) : 0
}

async function mapLimit(items, limit, fn) {
  const out = []
  let i = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }))
  return out
}

const { queries } = JSON.parse(fs.readFileSync(path.join(DIR, 'queries.json'), 'utf8'))
const corpus = loadCorpusText()
const lines = []
for (const q of queries) {
  const pool = new Set(await search(q.query, K))
  for (const s of SEEDS[q.id] || []) pool.add(s)
  const keys = [...pool]
  const grades = await mapLimit(keys, 6, async k => {
    const t = corpus.get(k)
    if (!t) return null
    return grade(q.query, t.title, t.desc)
  })
  let n2 = 0
  keys.forEach((k, idx) => {
    if (grades[idx] === null) return
    const [sid, iid] = k.split(':')
    lines.push(JSON.stringify({ id: q.id, auction_safe_id: sid, item_id: iid, grade: grades[idx], by: MODEL }))
    if (grades[idx] === 2) n2++
  })
  console.log(`${q.id.padEnd(22)} judged ${keys.length} (${n2} highly relevant)`)
}
fs.writeFileSync(path.join(DIR, 'judgments.jsonl'), lines.join('\n') + '\n')
console.log(`\nwrote ${lines.length} judgments → judgments.jsonl`)
