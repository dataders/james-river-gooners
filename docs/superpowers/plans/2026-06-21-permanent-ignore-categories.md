# Permanently-ignore categories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let users promote a hidden category to "always hidden" inline in the live filter, and review/undo the always-hidden set from the account menu — deleting the duplicated category-prefs tree.

**Architecture:** The permanent baseline state (`baselineExcluded*`) already exists and persists (localStorage + cloud). We add four narrow store actions (`addBaselineGroup/Category`, `removeBaselineGroup/Category`) that mutate the baseline without the session-clobbering the existing `toggleBaseline*` do. `FilterBar` gains a post-hide "never show this" affordance + a 🔒 always-hidden/restore rendering, at group and chip level. The account menu's category section is replaced by a compact `AlwaysHiddenCategories` review list (chips + ✕), and the duplicated `CategoryPrefsList`/`GroupSection` is deleted.

**Tech Stack:** React 19, Zustand store (`src/stores/preferencesStore.js`), Vitest, plain CSS (`src/index.css`).

**Spec:** `docs/superpowers/specs/2026-06-21-permanent-ignore-categories-design.md`

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/stores/preferencesStore.js` | + `addBaselineGroup`, `addBaselineCategory` (union into baseline, leave session/URL untouched); `removeBaselineGroup`, `removeBaselineCategory`, `clearBaseline` (remove from baseline **and** un-hide from session + sync URL). |
| `src/hooks/usePreferences.js` | Expose the 5 new actions. |
| `src/components/FilterBar.jsx` | Post-hide "never show this" + 🔒 always-hidden/restore at group & chip level. Reads `baselineExcludedGroups/Categories`. |
| `src/components/AlwaysHiddenCategories.jsx` | NEW compact review list (replaces `CategoryPrefsModal.jsx`). |
| `src/components/CategoryPrefsModal.jsx` | DELETE (`CategoryPrefsList` + duplicated `GroupSection`). |
| `src/components/AccountMenuBody.jsx` | Use `AlwaysHiddenCategories`; drop full-tree props. |
| `src/components/AccountButton.jsx`, `src/components/NavDrawer.jsx`, `src/App.jsx` | Thread the new baseline arrays + remove actions; drop `onToggleBaselineGroup/Category` + `groupedCategories` where now unused. |
| `src/index.css` | `.filter-chip-promote`, `.filter-group.always-hidden`, `.always-hidden-list` styles. |
| `src/data/changelog.js` + `CHANGELOG.md` | "What's New" line. |

---

## Task 1: Store actions (TDD)

**Files:**
- Modify: `src/stores/preferencesStore.js`
- Test: `src/stores/preferencesStore.vitest.js` (create if absent)

- [ ] **Step 1: Write failing tests**

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferencesStore } from './preferencesStore'

describe('baseline add/remove without clobbering session', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      excludedGroups: ['Art', 'Furniture'],
      excludedCategories: ['Coins'],
      baselineExcludedGroups: [],
      baselineExcludedCategories: [],
    })
  })

  it('addBaselineGroup unions into baseline and leaves session as-is', () => {
    usePreferencesStore.getState().addBaselineGroup('Art')
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedGroups).toContain('Art')
    expect(s.excludedGroups).toEqual(['Art', 'Furniture']) // Furniture not clobbered
  })

  it('addBaselineGroup is idempotent', () => {
    usePreferencesStore.getState().addBaselineGroup('Art')
    usePreferencesStore.getState().addBaselineGroup('Art')
    expect(usePreferencesStore.getState().baselineExcludedGroups).toEqual(['Art'])
  })

  it('removeBaselineGroup drops from baseline AND un-hides the session', () => {
    usePreferencesStore.setState({ baselineExcludedGroups: ['Art'] })
    usePreferencesStore.getState().removeBaselineGroup('Art')
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedGroups).not.toContain('Art')
    expect(s.excludedGroups).not.toContain('Art')
    expect(s.excludedGroups).toContain('Furniture')
  })

  it('addBaselineCategory / removeBaselineCategory mirror group behavior', () => {
    usePreferencesStore.getState().addBaselineCategory('Coins')
    expect(usePreferencesStore.getState().baselineExcludedCategories).toContain('Coins')
    usePreferencesStore.getState().removeBaselineCategory('Coins')
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedCategories).not.toContain('Coins')
    expect(s.excludedCategories).not.toContain('Coins')
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npm run test:vitest -- preferencesStore` → FAIL (actions undefined). (Local Node 26 note: use `NODE_OPTIONS=--localstorage-file=/tmp/ls` if localStorage teardown errors.)

- [ ] **Step 3: Implement** in the store's returned object (after `toggleBaselineCategory`):

```js
    // Add to the permanent baseline WITHOUT clobbering the session excluded set.
    // The item is already session-hidden (that's why the promote UI was shown),
    // so session/URL stay untouched; only the baseline gains the item.
    addBaselineGroup: (group) => {
      if (get().baselineExcludedGroups.includes(group)) return
      set({ baselineExcludedGroups: [...get().baselineExcludedGroups, group] })
      savePrefs(get())
    },
    addBaselineCategory: (cat) => {
      if (get().baselineExcludedCategories.includes(cat)) return
      set({ baselineExcludedCategories: [...get().baselineExcludedCategories, cat] })
      savePrefs(get())
    },
    // Restore: drop from baseline AND un-hide from the live session (+ URL sync),
    // so "restore" means "show it again now and stop hiding it by default".
    removeBaselineGroup: (group) => {
      const baselineExcludedGroups = get().baselineExcludedGroups.filter(g => g !== group)
      const excludedGroups = get().excludedGroups.filter(g => g !== group)
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      set({ baselineExcludedGroups, excludedGroups })
      savePrefs(get())
    },
    removeBaselineCategory: (cat) => {
      const baselineExcludedCategories = get().baselineExcludedCategories.filter(c => c !== cat)
      const excludedCategories = get().excludedCategories.filter(c => c !== cat)
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      set({ baselineExcludedCategories, excludedCategories })
      savePrefs(get())
    },
    clearBaseline: () => {
      const excludedGroups = get().excludedGroups.filter(g => !get().baselineExcludedGroups.includes(g))
      const excludedCategories = get().excludedCategories.filter(c => !get().baselineExcludedCategories.includes(c))
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      set({ baselineExcludedGroups: [], baselineExcludedCategories: [], excludedGroups, excludedCategories })
      savePrefs(get())
    },
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(prefs): baseline add/remove actions that don't clobber the session set`

---

## Task 2: Expose actions in `usePreferences`

**Files:** Modify `src/hooks/usePreferences.js`

- [ ] Add to the selector: `addBaselineGroup: s.addBaselineGroup, addBaselineCategory: s.addBaselineCategory, removeBaselineGroup: s.removeBaselineGroup, removeBaselineCategory: s.removeBaselineCategory, clearBaseline: s.clearBaseline`.
- [ ] Commit `feat(prefs): expose baseline add/remove actions`.

---

## Task 3: Inline promote/restore in `FilterBar`

**Files:** Modify `src/components/FilterBar.jsx`

Props added to `FilterBar` + `GroupSection`: `baselineExcludedGroups`, `baselineExcludedCategories`, `onAddBaselineGroup`, `onRemoveBaselineGroup`, `onAddBaselineCategory`, `onRemoveBaselineCategory`.

- [ ] **Group header** — compute `baselineHidden = baselineExcludedGroups.includes(group.group)`. Replace the single `filter-action` button block:

```jsx
{baselineHidden ? (
  <span className="filter-group-lock">
    <span className="lock-mark" aria-hidden="true">🔒</span>
    <button type="button" className="filter-action" onClick={() => onRemoveBaselineGroup(group.group)}>restore</button>
  </span>
) : isHidden ? (
  <span className="filter-group-actions">
    <button type="button" className="filter-action" onClick={() => onShowGroup(group.group, rawNames)}>show</button>
    <button type="button" className="filter-action filter-action--promote" onClick={() => onAddBaselineGroup(group.group)}>never show this</button>
  </span>
) : (
  <button type="button" className="filter-action" onClick={() => onHideGroup(group.group)}>hide</button>
)}
```

Add `always-hidden` to the group's className when `baselineHidden`.

- [ ] **Chip level** — for each `hidden` chip, append a promote/restore lock button (mirrors the `only` affordance on shown chips):

```jsx
{hidden.map(({ name, count }) => {
  const locked = baselineExcludedCategories.includes(name)
  return (
    <span key={name} className="filter-chip-wrap">
      <button className="filter-chip hidden" onClick={() => onToggle(name)}>
        <span className="x-mark">✕</span>{name}<span className="chip-count">{count}</span>
      </button>
      <button
        type="button"
        className={`filter-chip-promote${locked ? ' locked' : ''}`}
        title={locked ? `Restore ${name}` : `Never show ${name}`}
        aria-label={locked ? `Restore ${name}` : `Never show ${name}`}
        onClick={() => locked ? onRemoveBaselineCategory(name) : onAddBaselineCategory(name)}
      >🔒</button>
    </span>
  )
})}
```

- [ ] Thread the new props through the `FilterBar` → `GroupSection` map.
- [ ] Visual check via dev server (covered in Task 7). Commit `feat(filter): promote a hidden category to always-hidden inline`.

---

## Task 4: `AlwaysHiddenCategories` review list

**Files:** Create `src/components/AlwaysHiddenCategories.jsx`; delete `src/components/CategoryPrefsModal.jsx`.

- [ ] Create:

```jsx
// @ts-check
/**
 * @param {{
 *   baselineExcludedGroups: string[],
 *   baselineExcludedCategories: string[],
 *   onRemoveGroup: (g: string) => void,
 *   onRemoveCategory: (c: string) => void,
 *   onClearAll: () => void,
 * }} props
 */
export function AlwaysHiddenCategories({ baselineExcludedGroups, baselineExcludedCategories, onRemoveGroup, onRemoveCategory, onClearAll }) {
  const items = [
    ...baselineExcludedGroups.map(name => ({ name, remove: () => onRemoveGroup(name) })),
    ...baselineExcludedCategories.map(name => ({ name, remove: () => onRemoveCategory(name) })),
  ]
  if (items.length === 0) {
    return <p className="always-hidden-empty">Nothing hidden yet. Hide a category in Filters, then choose “never show this.”</p>
  }
  return (
    <div className="always-hidden-list">
      <div className="filter-chips">
        {items.map(({ name, remove }) => (
          <button key={name} type="button" className="filter-chip hidden" onClick={remove} title={`Restore ${name}`}>
            <span className="lock-mark" aria-hidden="true">🔒</span>{name}<span className="x-mark">✕</span>
          </button>
        ))}
      </div>
      <button type="button" className="filter-action" onClick={onClearAll}>restore all</button>
    </div>
  )
}
```

- [ ] `git rm src/components/CategoryPrefsModal.jsx` (after Task 5 removes its import). Commit `feat(prefs): compact always-hidden review list`.

---

## Task 5: Wire account menu + drawer + App

**Files:** Modify `AccountMenuBody.jsx`, `AccountButton.jsx`, `NavDrawer.jsx`, `App.jsx`.

- [ ] `AccountMenuBody.jsx`: replace import + the `groupedCategories?.length > 0` block. New props: `baselineExcludedGroups`, `baselineExcludedCategories`, `onRemoveBaselineGroup`, `onRemoveBaselineCategory`, `onClearBaseline`. Render the expandable "Always-hidden categories" section using `AlwaysHiddenCategories` (show only when there's ≥1 baseline item, or always — keep the expandable wrapper). Drop `onToggleBaselineGroup/Category` + `groupedCategories`.
- [ ] `AccountButton.jsx` + `NavDrawer.jsx`: swap the passed props to the new set.
- [ ] `App.jsx`: destructure `removeBaselineGroup, removeBaselineCategory, clearBaseline, addBaselineGroup, addBaselineCategory` from the store; pass remove/clear to `<AccountButton>`/`<NavDrawer>`; pass all six baseline props/actions to `<FilterPanel>` → `FilterBar`. Remove now-unused `toggleBaselineGroup/Category` from those JSX sites (keep in store).
- [ ] Update `FilterPanel.jsx` to forward the new category props to `FilterBar`.
- [ ] If `NavDrawer.vitest.jsx`/`AccountMenuBody.vitest.jsx` reference removed props, update them.
- [ ] `npm run test:vitest` green. Commit `feat: wire inline promote + always-hidden review list`.

---

## Task 6: CSS

**Files:** Modify `src/index.css`

- [ ] Add near the chip styles:

```css
.filter-action--promote { color: var(--gold); }
.filter-group-actions, .filter-group-lock { display: inline-flex; gap: 8px; align-items: center; }
.filter-group.always-hidden .filter-group-name { font-style: italic; opacity: 0.7; }
.lock-mark { font-size: 0.72rem; }
.filter-chip-promote {
  display: inline-flex; align-items: center; padding: 4px 7px;
  border: 1px solid var(--border); border-left: none;
  border-top-right-radius: 14px; border-bottom-right-radius: 14px;
  background: var(--surface); cursor: pointer; font-size: 0.7rem;
  opacity: 0.5; transition: all 0.15s;
}
.filter-chip-promote:hover, .filter-chip-promote:focus-visible {
  opacity: 1; border-color: var(--gold);
  background: color-mix(in srgb, var(--gold) 12%, var(--surface));
}
.filter-chip-promote.locked { opacity: 1; border-color: var(--gold); background: color-mix(in srgb, var(--gold) 18%, var(--surface)); }
.always-hidden-list { display: flex; flex-direction: column; gap: 8px; }
.always-hidden-empty { font-size: 0.8rem; color: var(--text-muted); margin: 4px 0; }
```

- [ ] Remove the now-orphaned `.account-catprefs` / `.catprefs-list` rules if nothing else uses them.
- [ ] Commit `style: inline promote + always-hidden chips`.

---

## Task 7: Screenshots + changelog + ship

- [ ] `npm run dev`; Playwright screenshot the Filters category section (hidden → "never show this" → 🔒 restore) and the account menu "Always-hidden categories" list at **375×667** and **1280×800**. Send to user, **wait for approval before merging** (CLAUDE.md gate).
- [ ] Add a dated entry to the top of `src/data/changelog.js` with fresh, never-reused line `id`s, and mirror into `CHANGELOG.md`.
- [ ] `npm run lint && npm run test:vitest && npm run ratchets` (and `npm run build`) green.
- [ ] Commit changelog; open PR with `gh pr create --base main`; subscribe to PR activity; watch CI to green.

---

## Notes / pitfalls

- The promote affordance only makes sense once a row is hidden — never render it on a shown row.
- `removeBaseline*` deliberately also clears the session exclusion (restore = show now). Keep this identical from both the filter row and the account chip so the two surfaces agree (spec success criterion #3).
- `DEFAULT_EXCLUDED_GROUPS` (`Firearms`, `Vehicles`) start in the baseline, so a fresh account's review list shows them — correct and restorable.
- Logged-out users have no account menu; they manage entirely inline in the filter. Don't wire the review list into a logged-out path.
