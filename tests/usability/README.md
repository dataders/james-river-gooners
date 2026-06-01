# Usability benchmark

Agent-style usability benchmark: automated "bidders" with objectives drive the
live app and produce a scored report. See
[`docs/UX-REVIEW.md`](../../docs/UX-REVIEW.md) for the narrative review.

```bash
npm run test:usability
```

Runs in ~25s against the dev server (auto-started) and regenerates:

- `results/REPORT.md` — scored, human-readable report
- `results/scorecard.json` — machine-readable scorecard + raw results

## Layout

| File | Purpose |
|---|---|
| `objectives.js` | Bidder personas + task flows. Add new personas here. |
| `harness.js` | Instrumentation: step counting, perf/latency probes, a11y + responsive audits. |
| `report.js` | Scoring (Usable / Fast / Responsive / Intuitive / Accessible) → Markdown + JSON. |
| `benchmark.spec.js` | Runner that ties it together (serial, single worker). |

## Scoring

A weighted 0–100 grade across five dimensions:

- **Usable** (30%) — share of objectives completed (excludes data-blocked tasks)
- **Fast** (25%) — data-ready, FCP, and interaction latency vs budgets
- **Responsive** (20%) — viewport checks (no overflow, tap-target size, grid fits)
- **Intuitive** (15%) — actual steps vs optimal steps per task
- **Accessible** (10%) — accessible names, alt text, headings, contrast

Objectives report `pass` / `fail` / `blocked`. `blocked` means the data (not the
UI) prevented completion — e.g. no eBay comps exist for any current lot — and is
excluded from the usability score so data gaps don't penalize the interface.
