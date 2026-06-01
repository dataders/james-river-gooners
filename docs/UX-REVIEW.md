# UX / UI Review — James River Gooners

_Agent-driven usability review of the Cannon's Auctions browsing site._

This review was produced by running an **agent-style usability benchmark**: a set
of automated "bidders," each with a real objective, that drive the live app
through the browser and measure how much friction each task involves. The
machine-generated scorecard lives at
[`tests/usability/results/REPORT.md`](../tests/usability/results/REPORT.md) and
regenerates with `npm run test:usability`. This document is the human read on top
of it.

## TL;DR

**Overall grade: A (98 / 100)** — up from B (88) after acting on the benchmark.
The site is fast, the core bidding workflows all work, and accessibility
fundamentals are solid. This PR fixed the two biggest gaps the benchmark found:
**undersized header touch targets** (Responsive 57 → 100) and the **missing sort
control** (bidders can now order by ending-soonest / price / bids).

| Dimension | Score | Verdict |
|---|---:|---|
| Usable (task completion) | 100 | All 9 bidder objectives completed |
| Fast (load + interaction) | 90 | Sub-second load; interaction slightly over budget |
| Responsive (layout integrity) | 100 | ✅ Header controls now meet ≥40px tap targets |
| Intuitive (steps vs optimal) | 100 | Sort + one-click category isolation |
| Accessible | 100 | Good ARIA, alt text, 19.7:1 text contrast |

> Earlier baseline (before this PR): Responsive **57** (theme toggle 38×26, help
> 27×25, Categories row 27px tall) and **no sort control**.

## Should there be a usability benchmark? — Yes, and now there is one

You asked whether there should be "a benchmark of usability or something." The
answer is yes, and it's worth saying _why_: a UX review done once is a snapshot
that goes stale the next time someone ships a filter change. A benchmark turns
"is the site usable?" into a number you can watch over time and gate PRs on.

What I built (`tests/usability/`):

- **`objectives.js`** — nine bidder personas (Newcomer, Collector, Bargain
  hunter, Category shopper, Local pickup buyer, Returning bidder, Sharer,
  Flipper, Mobile bidder). Each has a goal and an "optimal step count," and
  drives the real UI to accomplish it.
- **`harness.js`** — instrumentation: step counting, friction notes, load/FCP
  timing, interaction-latency measurement, a dependency-free accessibility audit,
  and a responsive sweep across phone / tablet / desktop.
- **`report.js`** — scores five dimensions (Usable, Fast, Responsive, Intuitive,
  Accessible) into a weighted 0–100 grade and writes a Markdown + JSON report.
- **`npm run test:usability`** — runs the whole thing in ~25s against the live dev
  server and regenerates the scorecard.

Because it reuses the existing Playwright setup, it can run in CI and fail a PR if
the overall score regresses below a threshold.

## What's working well

- **Every core task completes.** Search → detail, favorite → persist across
  reload, ROI calculator, locality filter, deep-link sharing — all nine
  objectives pass. The "Usable" score is a clean 100.
- **It's genuinely fast.** First contentful paint ~210 ms, full data-ready
  (Parquet/ndjson parsed, grid populated) in **~880 ms** for ~6,000 lots. That's
  excellent for an in-browser data app.
- **Deep links work.** Opening a lot updates the URL, and pasting that URL into a
  fresh tab reopens the exact lot after load. (My first benchmark run flagged
  this as broken — that turned out to be a _test_ bug, `isVisible()` not
  auto-waiting, not an app bug. The feature is solid.)
- **Accessibility fundamentals are in place.** Interactive controls have
  accessible names, images have alt text, there's exactly one `<h1>`, and item
  text contrast is 19.7:1 (WCAG AA needs 4.5:1).
- **Favorites and filter state survive reloads** via cookie + URL — a returning
  bidder picks up where they left off.

## Bugs surfaced while building the benchmark

Standing up the benchmark (and chasing the resulting CI run) turned up two real,
pre-existing defects — exactly the kind of regression a benchmark exists to catch:

- **🐞 Archive toggle crashed the grid (fixed in this PR).** Enabling "Archived
  auctions" could surface two lots sharing a bare `id`; `MiniSearch` throws on
  duplicate ids, and with no error boundary the whole `<main>` unmounted — grid,
  cards, and item count all vanished. Fixed by de-duplicating by `id` before
  building the search index (`src/hooks/useSearch.js`).
- **🐞 "Ends within = Any" hides 289 dateless lots (tracked in #65).** At its
  maximum the slider says "Any" but still excludes the 289 active items that have
  no end date. Filed separately as a focused app fix.

## Findings & prioritized recommendations

### P1 — Touch targets too small ✅ FIXED IN THIS PR (Responsive 57 → 100)

The header controls measured well under a comfortable 44×44 px touch target on
every viewport (theme toggle 38×26, help `?` 27×25, Categories row 27 px tall).
**Fix:** the icon buttons (`.theme-toggle`, `.help-button`) now have a ≥40 px
min-width/height with centered content, and the filter toggle rows
(`.filter-bar-toggle`, `.auction-filter-toggle`) plus the pill toggles
(`.deals-toggle`) get a ≥36–40 px min-height. CSS-only; Responsive is now 100.

### P2 — No sorting ✅ FIXED IN THIS PR

There was **no way to sort** the grid. Bidders could filter a price/time range
but couldn't ask "show me the cheapest" or "what's ending soonest" — the most
valuable sort for an auction. **Fix:** added a sort dropdown (Featured / Ending
soonest / Ending latest / Price ↑ / Price ↓ / Most bids), wired through
`usePreferences` so it persists in the URL and localStorage like the other
filters. Logic + unit tests in `src/utils/sort.js`.

### P3 — Isolating one category took 4 steps ✅ FIXED (Intuitive 94 → 100)

To see _only_ furniture, a bidder used to: open Categories → "hide all" → expand
the group → re-show the one category (4 interactions vs an optimal of ~2).
**Fix:** every shown category chip now has a one-click **"only"** button that
isolates that category (excludes all others); "show all" undoes it. The existing
toggle behavior is unchanged. Intuitive is now 100.

### P4 — Verify semantic ("AI") search in production (Robustness)

The console shows `Cannot read properties of undefined (reading 'registerBackend')`
from the `@xenova/transformers` CLIP worker. In dev this means the semantic-search
backend fails to initialize, so the "AI ✓" badge / image-similarity search likely
isn't functioning. Keyword search is unaffected and the app degrades gracefully,
so users aren't blocked — but the headline AI feature may be silently down.
**Recommendation:** confirm whether this reproduces in a production build
(`npm run build && npm run preview`); if so, it's usually an ONNX-runtime-web /
WASM backend init issue under Vite.

### P5 — Interaction latency slightly over budget (Fast)

Search settled in ~430 ms and filtering in ~390 ms against a 300 ms budget. ~200 ms
of the search figure is the deliberate input debounce, so perceived latency is
fine — but on the full ~6,000-lot set the post-debounce recompute is the larger
share. **Recommendation:** only if it becomes noticeable, memoize the filter
pipeline more aggressively or precompute a lowercased search corpus. Low priority.

### Note — image cert errors are environment-specific

The `ERR_CERT_AUTHORITY_INVALID` console noise is the sandbox proxy intercepting
external lot images; it is not a real production defect.

## How to use this going forward

```bash
npm run test:usability      # regenerate tests/usability/results/REPORT.md
```

Add new personas to `tests/usability/objectives.js` as the app grows. A natural
next step is to wire this into CI and fail the build if the overall score drops
below, say, 85 — turning "usable, responsive, fast, intuitive" from an aspiration
into a regression test.
