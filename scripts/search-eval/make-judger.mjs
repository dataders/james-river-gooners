#!/usr/bin/env node
/**
 * Build a self-contained judging page (judge.html) so a human can rate search
 * results by hand — seeing each lot's PHOTO, which matters since many titles are
 * just "Lot - 27". Open the file in a browser, grade with the 2 / 1 / 0 buttons
 * (or keys), then "Download judgments.jsonl" and drop it next to this script.
 *
 * For each query it pools the top-K from the current search config plus any
 * hand-seeded known-relevant lots (so recall misses are judgeable too), and
 * embeds the candidates' photo + title + description into the page.
 *
 *   SUPABASE_URL=… VITE_SUPABASE_PUBLISHABLE_KEY=… \
 *     node scripts/search-eval/make-judger.mjs [--k 12] [--queries silver-coins,table-lamp]
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
const K = process.argv.includes('--k') ? Number(process.argv[process.argv.indexOf('--k') + 1]) : 12
const onlyQueries = process.argv.includes('--queries')
  ? process.argv[process.argv.indexOf('--queries') + 1].split(',')
  : null

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Need SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in env.')
  process.exit(2)
}

const key = (s, i) => `${s}:${i}`

// Optional hand-seeded known-relevant lots (so misses are judgeable). Keep in
// sync with judge.mjs SEEDS if you use both.
let SEEDS = {}
try { SEEDS = JSON.parse(fs.readFileSync(path.join(DIR, 'seeds.json'), 'utf8')) } catch { /* optional */ }

function loadCorpus() {
  const dir = path.join(ROOT, 'public/data/items')
  const meta = new Map()
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ndjson'))) {
    const sid = f.slice(0, -7)
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const d = JSON.parse(line)
      let imgs = d.images || []
      if (typeof imgs === 'string') { try { imgs = JSON.parse(imgs) } catch { imgs = [] } }
      meta.set(key(sid, d.id), { title: d.title || '', desc: (d.description || '').slice(0, 300), image: imgs[0] || '' })
    }
  }
  return meta
}

let extractor = null
async function search(query) {
  if (!extractor) extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: 'q8' })
  const out = await extractor(`search_query: ${query}`, { pooling: 'mean', normalize: true })
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_lots_eval`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query_embedding: Array.from(out.data), match_count: K }),
  })
  if (!resp.ok) throw new Error(`match_lots_eval ${resp.status}`)
  return (await resp.json()).map(r => ({ key: key(r.auction_safe_id, r.item_id), similarity: r.similarity }))
}

let { queries } = JSON.parse(fs.readFileSync(path.join(DIR, 'queries.json'), 'utf8'))
if (onlyQueries) queries = queries.filter(q => onlyQueries.includes(q.id))
const corpus = loadCorpus()

const pool = []
for (const q of queries) {
  const seen = new Set()
  const cands = []
  for (const r of await search(q.query)) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    cands.push({ ...r, ...(corpus.get(r.key) || { title: '(missing)', desc: '', image: '' }) })
  }
  for (const s of SEEDS[q.id] || []) {
    if (seen.has(s)) continue
    seen.add(s)
    cands.push({ key: s, similarity: null, ...(corpus.get(s) || { title: '(missing)', desc: '', image: '' }) })
  }
  pool.push({ id: q.id, query: q.query, regime: q.regime, candidates: cands })
  console.log(`${q.id.padEnd(22)} ${cands.length} candidates`)
}

const html = `<!doctype html><meta charset="utf-8"><title>Search judging</title>
<style>
 body{font:15px/1.4 system-ui;margin:0;background:#111;color:#eee}
 header{position:sticky;top:0;background:#1c1c1c;padding:10px 16px;border-bottom:1px solid #333;z-index:5}
 h2{margin:18px 16px 6px}
 .q{color:#9cf} .regime{color:#888;font-size:12px}
 .card{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid #222}
 .card img{width:90px;height:90px;object-fit:cover;background:#000;border-radius:6px;flex:none}
 .meta{flex:1;min-width:0}
 .title{font-weight:600} .desc{color:#bbb;font-size:13px} .sim{color:#7a7;font-size:12px}
 .btns{display:flex;gap:6px;flex:none}
 button.g{width:40px;height:40px;border-radius:6px;border:1px solid #444;background:#222;color:#eee;cursor:pointer;font-size:16px}
 button.g.on2{background:#2a7;color:#000;border-color:#2a7}
 button.g.on1{background:#cd5;color:#000;border-color:#cd5}
 button.g.on0{background:#a44;border-color:#a44}
 #dl{position:fixed;right:16px;bottom:16px;padding:12px 18px;background:#2a7;color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer}
 .count{color:#9cf}
</style>
<header>
 Rate each lot for its query: <b>2</b>=highly relevant · <b>1</b>=somewhat · <b>0</b>=not relevant.
 Judged: <span id="n" class="count">0</span>/<span id="tot"></span>. Unjudged lots are excluded on download.
</header>
<div id="app"></div>
<button id="dl">⬇ Download judgments.jsonl</button>
<script>
const POOL = ${JSON.stringify(pool)};
const grades = {}; // "qid|key" -> 0/1/2
const app = document.getElementById('app');
let total = 0;
for (const q of POOL) {
  const h = document.createElement('h2');
  h.innerHTML = '<span class="q">"'+q.query+'"</span> <span class="regime">['+q.regime+']</span>';
  app.appendChild(h);
  for (const c of q.candidates) {
    total++;
    const id = q.id+'|'+c.key;
    const row = document.createElement('div'); row.className='card';
    row.innerHTML =
      (c.image?'<img loading="lazy" src="'+c.image+'">':'<img>')+
      '<div class="meta"><div class="title">'+esc(c.title)+'</div>'+
      '<div class="desc">'+esc(c.desc)+'</div>'+
      '<div class="sim">'+c.key+(c.similarity!=null?(' · sim '+c.similarity.toFixed(3)):' · seeded')+'</div></div>'+
      '<div class="btns">'+[2,1,0].map(g=>'<button class="g" data-id="'+id+'" data-g="'+g+'">'+g+'</button>').join('')+'</div>';
    app.appendChild(row);
  }
}
document.getElementById('tot').textContent = total;
app.addEventListener('click', e=>{
  const b = e.target.closest('button.g'); if(!b) return;
  const id=b.dataset.id, g=+b.dataset.g; grades[id]=g;
  [...b.parentNode.children].forEach(x=>x.className='g');
  b.className='g on'+g;
  document.getElementById('n').textContent = Object.keys(grades).length;
});
document.getElementById('dl').onclick = ()=>{
  const lines = Object.entries(grades).map(([k,g])=>{
    const [id, comp] = k.split('|'); const [sid, ...rest]=comp.split(':'); const iid=rest.join(':');
    return JSON.stringify({id, auction_safe_id:sid, item_id:iid, grade:g, by:'human'});
  });
  const blob = new Blob([lines.join('\\n')+'\\n'], {type:'application/x-ndjson'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='judgments.jsonl'; a.click();
};
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
</script>`

fs.writeFileSync(path.join(DIR, 'judge.html'), html)
console.log(`\nwrote judge.html (${pool.reduce((s, q) => s + q.candidates.length, 0)} candidates). Open it in a browser, grade, and download judgments.jsonl.`)
