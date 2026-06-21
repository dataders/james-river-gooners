# Permanently-ignore categories from the live filter

**Date:** 2026-06-21
**Status:** Approved (design), pending implementation plan

## Problem

The branch `claude/user-filter-prefs-rankings-884v1a` introduced a permanent
per-user category **baseline** (`baselineExcludedGroups` /
`baselineExcludedCategories`) — categories hidden by default every visit, which
also feed the "For You" signal. Its editor (`CategoryPrefsList` in
`src/components/CategoryPrefsModal.jsx`) was parked as an expand-in-place section
inside the account menu (`AccountMenuBody`, shown in both the desktop account
dropdown and the mobile `NavDrawer`).

Two problems with that placement:

1. **It's a near-duplicate of the live Categories filter.** `CategoryPrefsModal`'s
   `GroupSection` is a line-for-line copy of `FilterBar.jsx`'s `GroupSection`
   (same `filter-group` / `filter-chip` markup and CSS). Two trees, one concept.
2. **It's cramped and orphaned.** Nested two levels deep inside a dropdown menu,
   the full category tree reads as secondary and has no room. Users edit
   "permanent" preferences in a different place than they do live filtering, with
   no obvious relationship between the two.

The original framing ("where should a "preferences" surface live — a second
drawer, a right-side panel mirroring the filter?") was the wrong question. The
better answer dissolves the second surface entirely.

## Solution

**Promote in context.** The live Categories filter stays the single place
categories live. "Permanent" becomes a *second step* off the existing temporary
"hide", revealed by progressive disclosure only after a category is hidden. A
compact review/restore list in user preferences lets users see and undo what
they've permanently hidden — but it is **not** a second full tree.

A category row therefore has three states:

| State | Live filter row | Meaning | Persistence |
|-------|-----------------|---------|-------------|
| **Shown** | `▸ Art  828  [hide]` | normal | — |
| **Hidden this session** | `▸ Art  hidden  [show]  ·  [never show this]` | temporary; the promote affordance appears | session `excludedGroups`/`excludedCategories` |
| **Always hidden** | `🔒 Art  always hidden  [restore]` | permanent; seeds every visit + feeds For You | `baselineExcluded*` (localStorage + cloud `filter_preferences` when signed in) |

### Two surfaces, one source of truth

Both surfaces read/write the same `baseline*` state, which already persists to
localStorage and mirrors to the per-user cloud `filter_preferences` row on sign-in.

1. **Live filter — create.** Each filter row gains a **"never show this"**
   affordance that appears *after* the row is hidden. Clicking it promotes the
   exclusion into the baseline. Available at both **group** level (e.g. the whole
   *Art* group) and **raw chip** level (e.g. *Oil Paintings* inside an expanded
   group) — the baseline already stores groups and raw categories separately.
   Permanently-hidden rows render inline with a 🔒 marker and a **restore** action.

2. **User preferences — review.** The account-menu category section is replaced
   by a **compact "Always-hidden categories"** list: the muted groups/categories
   as removable chips (`🔒 Coins & Currency ✕`) plus a **restore all** action. It
   is a read/undo convenience, not an editor — you *add* permanent ignores from
   the filter, you *review/remove* them here.

### Wording

A single, consistent verb family that avoids collision with the per-item
not-interested list (which already owns "Ignored"):

- temporary action: **hide** / **show** (unchanged)
- promote action: **never show this**
- permanent state label: **always hidden**
- undo action: **restore**
- preferences section title: **Always-hidden categories**

## Components affected

| File | Change |
|------|--------|
| `src/components/FilterBar.jsx` | Add the post-hide "never show this" promote affordance and the 🔒 "always hidden / restore" rendering, at group and chip level. This is the one category tree. |
| `src/components/CategoryPrefsModal.jsx` | **Delete** `CategoryPrefsList` + its duplicated `GroupSection` (the second tree). Replace with — or move to a new small component for — the compact review/restore list. |
| `src/components/AccountMenuBody.jsx` | Swap the embedded `CategoryPrefsList` for the compact "Always-hidden categories" review list; drop the now-unused full-tree props. |
| `src/components/NavDrawer.jsx` | Pass through whatever the (now compact) review list needs; drop unused full-tree props. |
| `src/stores/preferencesStore.js` | Add an `addToBaseline` (group + category) action that **adds to the baseline without clobbering the session `excluded*` set**. Add a `removeFromBaseline` / restore action. See "Key implementation note". |
| `src/index.css` | Styles for the promote affordance, the 🔒 always-hidden row, and the review chips. |
| `src/App.jsx` | Wire the new store actions to the filter + account menu; drop props removed above. |
| `src/data/changelog.js` + `CHANGELOG.md` | A user-facing "What's New" line (fresh, never-reused `id`s) describing "never show this" / always-hidden categories. |

`FilterPanel.jsx` passes the category props straight through to `FilterBar`; it
gains the new promote/restore handlers in that pass-through.

## Key implementation note: don't clobber the session set

The existing `toggleBaselineGroup` / `toggleBaselineCategory` actions set the
baseline **and** force the live session `excluded*` to *equal* the baseline:

```js
set({ baselineExcludedGroups: next, excludedGroups: next })
```

That is correct for the old full-tree editor (where the editor *is* the session),
but wrong for inline promotion: a user who has hidden several categories this
session and then promotes one would lose the other session-only hides. The new
`addToBaseline` must **union** the item into the baseline while leaving the
session `excluded*` as-is (the item is already in it — that's why the promote
affordance was visible).

Two details the plan must settle explicitly so the two surfaces behave
identically:

- **Restore semantics (decision required).** Recommended: `removeFromBaseline`
  removes the item from the baseline **and** un-hides it from the current session
  (so "restore" = "show it again now and stop hiding it by default"), since a 🔒
  always-hidden row is, by definition, also currently hidden. Pick one behavior
  and apply it the same way from both the inline filter row and the account-menu
  chip.
- **URL-param parity.** Every existing category action in the store calls
  `syncUrlParam(URL_PARAMS.excludedGroups/excludedCategories, …)` after mutating
  state. The new `addToBaseline` / `removeFromBaseline` actions must keep the same
  URL sync where they change the session `excluded*` set, or the shareable-link
  state will drift out of sync with the grid.

## Persistence / auth

No schema change. The baseline already round-trips through localStorage
(`gooners-preferences`) and the cloud `filter_preferences` row, so:

- **Logged out:** permanent ignores work and persist on the device (localStorage).
- **Logged in:** they sync to the account via the existing `applyPrefs` cloud path.

The inline filter rows are the universal management surface (available to
everyone). The consolidated "Always-hidden categories" review list lives in the
account menu (`AccountMenuBody`), which renders for signed-in users; logged-out
users manage entirely inline in the filter. (If a logged-out consolidated view is
later wanted, it can be added without schema changes — out of scope here.)

## Out of scope / not doing

- No second drawer, no right-side preferences sidebar, no drawer reorganization —
  ☰ and the account menu structure are otherwise left as they are.
- No new Supabase table or migration.
- No change to the per-item favorites / not-interested ("Ignored") lists.

## Success criteria

1. Hiding a category in the live filter reveals a "never show this" affordance;
   clicking it makes the category survive a page reload (and a logout/login when
   signed in), and seeds the hidden state on the next visit.
2. Promoting one category does not un-hide other categories hidden this session.
3. Permanently-hidden categories appear with 🔒 + restore inline, and as
   removable chips in the account menu's "Always-hidden categories" list;
   restoring from either surface removes them from the baseline.
4. Group-level and raw-chip-level promotion both work.
5. The duplicated full-tree `GroupSection` no longer exists in the codebase.
6. A "What's New" changelog entry ships with the change.
