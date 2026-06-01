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

**Overall grade: B (88 / 100).** The site is fast, the core bidding workflows all
work, and accessibility fundamentals are solid. The two things holding it back
from an A are **touch-target sizes on the header controls** and a handful of
**missing-affordance gaps** (no sort, no one-click category isolation). Nothing
here is a five-alarm fire — these are polish items on an already-strong app.

| Dimension | Score | Verdict |
|---|---:|---|
| Usable (task completion) | 100 | All 9 bidder objectives completed |
| Fast (load + interaction) | 90 | Sub-second load; interaction slightly over budget |
| Responsive (layout integrity) | 57 | ⚠️ Undersized tap targets drag this down |
| Intuitive (steps vs optimal) | 94 | One task needs more steps than it should |
| Accessible | 100 | Good ARIA, alt text, 19.7:1 text contrast |

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

### P1 — Touch targets are too small (Responsive: 57/100)

The header controls measure well under a comfortable 44×44 px touch target on
every viewport:

| Control | Size | Note |
|---|---|---|
| Theme toggle | 38 × 26 px | 26 px tall |
| Help `?` button | 27 × 25 px | smallest target on the page |
| Categories toggle row | full-width × 27 px | tall enough to find, short to tap |

These clear the bare WCAG 2.5.8 minimum (24 px) but are fiddly on a phone — and
this site's bidders are often browsing on mobile. **Recommendation:** bump the
icon buttons to a ≥40 px min-height/width and give the filter toggle rows a
little more vertical padding on small screens. This is a CSS-only change and
would move the Responsive score from ~57 to ~90+.

### P2 — No sorting (Intuitive)

The Bargain-hunter objective surfaced this: there is **no way to sort** the grid
(by price, by ending-soonest, by bid count). Bidders can _filter_ a range with
the sliders, but "show me the cheapest lots" or "what's ending in the next hour"
requires manual scanning. For an auction site, **ending-soonest** is the single
most valuable sort. **Recommendation:** add a small sort dropdown
(Ending soonest / Price ↑ / Price ↓ / Most bids).

### P3 — Isolating one category takes 4 steps (Intuitive)

To see _only_ furniture, a bidder must: open Categories → "hide all" → expand the
group → re-show the one category. The benchmark measured 4 interactions against an
optimal of ~2. **Recommendation:** add an "only" affordance on each category chip
(click the chip = filter to just that category; a small ✕ keeps the current
toggle behavior), or a top-level category `<select>`.

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
