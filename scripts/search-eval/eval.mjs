#!/usr/bin/env node
/**
 * Search-quality benchmark for the Nomic semantic search.
 *
 * Measures ranking quality against a frozen corpus (the `eval_embeddings` table)
 * and a committed set of relevance judgments, so we can change the embedding
 * model / fusion / params and SEE whether results got better or worse instead of
 * guessing. See README.md.
 *
 * Faithful to production: the query is embedded with the SAME path the browser
 * uses — nomic-embed-text-v1.5 via transformers.js at q8 — not Python fp32. (The
 * item vectors are Python fp32; measuring with an fp32 query would score a system
 * users don't actually get.)
 *
 * Usage (needs SUPABASE_URL + a Supabase key in env):
 *   node scripts/search-eval/eval.mjs pool [--k 15]   # print candidates to judge
 *   node scripts/search-eval/eval.mjs run             # score vs baseline.json
 *   node scripts/search-eval/eval.mjs baseline        # (re)write baseline.json
 */
import { pipeline, env } from '@huggingface/transformers'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

env.allowLocalModels = false

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const SUPABASE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY
const REGRESSION_THRESHOLD = Number(process.env.SEARCH_EVAL_THRESHOLD || 0.02)

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and a Supabase key (VITE_SUPABASE_PUBLISHABLE_KEY) in env.')
  process.exit(2)
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(path.join(DIR, p), 'utf8'))
}
function readJsonl(p) {
  const full = path.join(DIR, p)
  if (!fs.existsSync(full)) return []
  return fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

const key = (safeId, itemId) => `${safeId}:${itemId}`

// --- query embedding -------------------------------------------------------
// Defaults to q8 — the production browser path. Override with SEARCH_EVAL_DTYPE
// (q8 | fp16 | fp32) to A/B whether the browser's quantization costs relevance
// vs a heavier-but-more-faithful model.
const DTYPE = process.env.SEARCH_EVAL_DTYPE || 'q8'
let extractor = null
async function embed(query) {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: DTYPE })
  }
  const out = await extractor(`search_query: ${query}`, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

async function search(query, k) {
  const embedding = await embed(query)
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_lots_eval`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: embedding, match_count: k }),
  })
  if (!resp.ok) throw new Error(`match_lots_eval ${resp.status}: ${await resp.text()}`)
  return resp.json() // [{auction_safe_id, item_id, title, category, similarity}]
}

// --- metrics ---------------------------------------------------------------
// judgments: grade 0 (irrelevant) / 1 (somewhat) / 2 (highly). "relevant" = >=1.
function dcg(grades) {
  return grades.reduce((s, g, i) => s + g / Math.log2(i + 2), 0)
}
function ndcgAtK(rankedGrades, allGrades, k) {
  const ideal = [...allGrades].sort((a, b) => b - a).slice(0, k)
  const idcg = dcg(ideal)
  if (idcg === 0) return null // no relevant items judged → undefined, skip
  return dcg(rankedGrades.slice(0, k)) / idcg
}
function recallAtK(ranked, relevantSet, k) {
  if (relevantSet.size === 0) return null
  const hit = ranked.slice(0, k).filter(key => relevantSet.has(key)).length
  return hit / relevantSet.size
}
function reciprocalRank(ranked, relevantSet, k) {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevantSet.has(ranked[i])) return 1 / (i + 1)
  }
  return 0
}

function mean(xs) {
  const v = xs.filter(x => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

async function scoreAll() {
  const { queries } = readJson('queries.json')
  const judgments = readJsonl('judgments.jsonl')
  // grade lookup: query id -> key -> grade
  const byQuery = new Map()
  for (const j of judgments) {
    if (!byQuery.has(j.id)) byQuery.set(j.id, new Map())
    byQuery.get(j.id).set(key(j.auction_safe_id, j.item_id), j.grade)
  }

  const rows = []
  for (const q of queries) {
    const grades = byQuery.get(q.id)
    if (!grades || grades.size === 0) continue // unjudged query → skip
    const results = await search(q.query, 20)
    const rankedKeys = results.map(r => key(r.auction_safe_id, r.item_id))
    const rankedGrades = rankedKeys.map(k => grades.get(k) ?? 0)
    const allGrades = [...grades.values()]
    const relevant = new Set([...grades.entries()].filter(([, g]) => g >= 1).map(([k]) => k))
    rows.push({
      id: q.id,
      regime: q.regime,
      ndcg10: ndcgAtK(rankedGrades, allGrades, 10),
      recall20: recallAtK(rankedKeys, relevant, 20),
      mrr10: reciprocalRank(rankedKeys, relevant, 10),
    })
  }
  const agg = {
    ndcg10: mean(rows.map(r => r.ndcg10)),
    recall20: mean(rows.map(r => r.recall20)),
    mrr10: mean(rows.map(r => r.mrr10)),
    queries: rows.length,
  }
  return { rows, agg }
}

function fmt(x) {
  return x === null ? '  —  ' : x.toFixed(3)
}

// --- commands --------------------------------------------------------------
async function cmdPool(k) {
  const { queries } = readJson('queries.json')
  for (const q of queries) {
    const results = await search(q.query, k)
    console.log(`\n### ${q.id}  "${q.query}"  [${q.regime}]`)
    for (const r of results) {
      console.log(
        `${r.similarity.toFixed(3)}  ${r.auction_safe_id}\t${r.item_id}\t[${r.category}] ${(r.title || '').slice(0, 60)}`
      )
    }
  }
}

async function cmdRun() {
  const { rows, agg } = await scoreAll()
  console.log('\nquery                  regime    nDCG@10 Recall@20 MRR@10')
  console.log('-'.repeat(60))
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(22)} ${r.regime.padEnd(9)} ${fmt(r.ndcg10)}   ${fmt(r.recall20)}   ${fmt(r.mrr10)}`
    )
  }
  console.log('-'.repeat(60))
  console.log(`${'AGGREGATE'.padEnd(22)} ${String(agg.queries).padEnd(9)} ${fmt(agg.ndcg10)}   ${fmt(agg.recall20)}   ${fmt(agg.mrr10)}`)

  const baselinePath = path.join(DIR, 'baseline.json')
  if (fs.existsSync(baselinePath)) {
    const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
    const drop = base.agg.ndcg10 - agg.ndcg10
    console.log(`\nbaseline nDCG@10 ${fmt(base.agg.ndcg10)} → current ${fmt(agg.ndcg10)} (Δ ${(-drop).toFixed(3)})`)
    if (drop > REGRESSION_THRESHOLD) {
      console.error(`REGRESSION: nDCG@10 dropped ${drop.toFixed(3)} > ${REGRESSION_THRESHOLD}. ` +
        `If this change is intended, update baseline.json in the same PR.`)
      process.exit(1)
    }
  } else {
    console.log('\n(no baseline.json yet — run `baseline` to write one)')
  }
}

async function cmdBaseline() {
  const { agg } = await scoreAll()
  const out = { generatedAt: new Date().toISOString(), config: `nomic-embed-text-v1.5 ${DTYPE} + match_lots_eval`, agg }
  fs.writeFileSync(path.join(DIR, 'baseline.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('wrote baseline.json:', JSON.stringify(agg))
}

const cmd = process.argv[2] || 'run'
const kArg = process.argv.includes('--k') ? Number(process.argv[process.argv.indexOf('--k') + 1]) : 15
if (cmd === 'pool') await cmdPool(kArg)
else if (cmd === 'baseline') await cmdBaseline()
else await cmdRun()
