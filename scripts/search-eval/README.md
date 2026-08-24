# Search-quality benchmark

A regression harness for the Nomic semantic search. It scores how well the
search ranks relevant lots against a **frozen corpus** and a set of **relevance
judgments**, so we can change the model / fusion / params and *see* whether
results got better or worse instead of guessing.

## Why

Without this, "is search better?" is a vibe check, and an improvement to one
query can silently wreck another. The harness gives a single defensible number
(`nDCG@10`) plus a per-query breakdown, and a baseline to defend.

## Pieces

| file | what |
|---|---|
| `queries.json` | the benchmark queries (3 regimes: `category`, `specific`, `hybrid`). Stable — add new ones with fresh ids. |
| `seeds.json` | hand-seeded known-relevant lots that the search may *fail* to surface, so recall misses are measurable (avoids pooling bias). |
| `judgments.jsonl` | `(query id, lot, grade)` where grade is `2` highly / `1` somewhat / `0` not relevant. The ground truth. |
| `baseline.json` | the committed scores of the current config. **The line you defend.** |
| `eval.mjs` | runs the search for each judged query and prints nDCG@10 / Recall@20 / MRR@10, diffing the baseline. |
| `make-judger.mjs` | builds `judge.html` — a self-contained page to grade lots by hand (with photos). |
| `judge.mjs` | optional: grade pools with an LLM judge (GPT-5.6 Luna) to scale labeling. Needs `OPENAI_API_KEY`. |

The corpus is the `eval_embeddings` Supabase table (migration `0013`) — a frozen
snapshot of `nomic_embeddings`, decoupled from the live table that churns hourly,
so the baseline stays reproducible. Refresh it deliberately (see the migration
header) and re-judge + re-baseline in the same PR.

## Faithful to production (the q8 vs fp32 thing)

Production embeds the **query** in the browser with `nomic-embed-text` at **q8**
(8-bit quantized, for a small download) but the **item** vectors are Python
**fp32**. Quantization shifts the query vector slightly, which reshuffles the top
of the ranking (measured: only ~7/10 top-10 overlap between q8 and fp32 queries).
So the harness embeds eval queries at **q8 by default** — measuring the system
users actually get, not an fp32 lab approximation. Compare dtypes with
`SEARCH_EVAL_DTYPE=q8|fp16|fp32` to decide if the browser's quantization is
costing relevance.

## Usage

All commands need `SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` in env.

```bash
# Score the current config vs the committed baseline (exit 1 if nDCG@10 drops
# more than SEARCH_EVAL_THRESHOLD, default 0.02):
node scripts/search-eval/eval.mjs run

# Re-baseline (do this in the same PR as an intended improvement):
node scripts/search-eval/eval.mjs baseline

# A/B the browser quantization:
SEARCH_EVAL_DTYPE=fp32 node scripts/search-eval/eval.mjs run
```

### Judging by hand (recommended)

```bash
node scripts/search-eval/make-judger.mjs            # build judge.html (all queries)
node scripts/search-eval/make-judger.mjs --queries silver-coins,table-lamp --k 12
```

Open `judge.html` in a browser, rate each lot **2 / 1 / 0** (you see the photo —
essential for the `Lot - 27` placeholder titles), click **Download
judgments.jsonl**, and replace this folder's `judgments.jsonl`. Then re-baseline.

### Judging with the LLM (to scale)

```bash
OPENAI_API_KEY=… node scripts/search-eval/judge.mjs --k 15
```

Validate the LLM's grades against a hand-labeled sample (aim for ≥80% agreement)
before trusting them — humans stay the final arbiter.

## Current state & limitations

- `judgments.jsonl` is a **starter seed**: top results were hand-graded from each
  lot's title/description; some lower ranks were graded by category as a proxy.
  Refine it with the judging page — that's the intended workflow.
- The baseline immediately flags real failures: **oil-paintings, oriental-rug,
  sterling-flatware, pyrex-bowls, cast-iron-skillet score 0.000** — the search
  fails to surface lots that exist in the corpus (placeholder-titled lots losing
  to text-heavy stamp/coin listings). These are the first things to fix.
- No CI gate yet (deliberate — the seed needs human refinement first). Once the
  judgments are trusted, wire `eval.mjs run` into CI to block regressions.

## What you can tune (and now measure)

Item-vector fusion (`text + mean(images)` weighting), `GOONERS_MAX_IMAGES`, the
query task prefix, browser dtype, hybrid keyword∩semantic blending, HNSW
`ef_search`, top-K. Change one, run `eval.mjs`, keep it only if the number goes up.
