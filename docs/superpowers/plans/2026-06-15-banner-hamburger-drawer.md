# Banner hamburger drawer (mobile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile (`<700px`), collapse the six header utility icons and the account button behind a left-sliding hamburger drawer; mirror the bid-alert count onto the hamburger. Desktop is unchanged.

**Architecture:** A new presentational `NavDrawer` component renders the account menu + utility actions + theme toggle as a left slide-in panel. The account menu body is extracted from `AccountButton` into a shared `AccountMenuBody` so both the desktop dropdown and the drawer reuse one copy of the auth logic (DRY). A pure `headerBadge` helper decides what the hamburger shows (bid count → dot → nothing). CSS hides `.header-actions` and the inline account button on mobile and reveals the hamburger; desktop CSS is untouched.

**Tech Stack:** React 19, plain CSS (`src/index.css`), Vitest + @testing-library/react for component tests (`*.vitest.jsx`), `node --test` for pure-util tests (`*.test.js`), Playwright for screenshots.

**Spec:** `docs/superpowers/specs/2026-06-15-banner-hamburger-drawer-design.md`

---

## File Structure

- **Create** `src/utils/headerBadge.js` — pure helper: given `(alertCount, hasUnseen)` return what the hamburger badge shows. One responsibility: badge priority.
- **Create** `src/utils/headerBadge.test.js` — `node --test` unit tests for the helper.
- **Create** `src/components/AccountMenuBody.jsx` — the logged-in account menu items (email, Cannon's link, change-password form, sign out), extracted verbatim from `AccountButton`. Owns its own password-change state. Calls `onAfterAction()` to let the container close.
- **Create** `src/components/AccountMenuBody.vitest.jsx` — component tests for the extracted body.
- **Create** `src/components/NavDrawer.jsx` — the mobile hamburger drawer (overlay + left panel). Presentational; takes handlers/state as props.
- **Create** `src/components/NavDrawer.vitest.jsx` — component tests for the drawer.
- **Modify** `src/components/AccountButton.jsx` — replace the inline dropdown body with `<AccountMenuBody>` (behavior identical on desktop).
- **Modify** `src/App.jsx:454-556` — add `navOpen` state, the hamburger button in `.header-banner`, lift `bidAlertCount`, render `<NavDrawer>`.
- **Modify** `src/index.css` — `.header-menu-button` styles; mobile show/hide flip (hide `.header-actions` + inline account, show hamburger); `.nav-drawer-*` overlay/panel/rows; `nav-slide-in` keyframe.
- **Modify** `src/data/changelog.js` + `CHANGELOG.md` — user-facing "What's new" entry.

Read @superpowers:test-driven-development before starting. Conventions: pure-util tests are `src/utils/*.test.js` (`npm run test:unit`); React component tests are `src/**/*.vitest.jsx` (`npm run test:vitest`).

---

### Task 1: `headerBadge` pure helper

**Files:**
- Create: `src/utils/headerBadge.js`
- Test: `src/utils/headerBadge.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/utils/headerBadge.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { headerBadge } from './headerBadge.js'

test('bid alerts take priority and show a count', () => {
  assert.deepEqual(headerBadge(3, true), { kind: 'count', value: '3' })
})

test('counts above 9 clamp to 9+', () => {
  assert.deepEqual(headerBadge(12, false), { kind: 'count', value: '9+' })
})

test('falls back to the unseen dot when no bid alerts', () => {
  assert.deepEqual(headerBadge(0, true), { kind: 'dot', value: '' })
})

test('nothing when no alerts and nothing unseen', () => {
  assert.deepEqual(headerBadge(0, false), { kind: 'none', value: '' })
})

test('treats missing/negative counts as zero', () => {
  assert.deepEqual(headerBadge(undefined, true), { kind: 'dot', value: '' })
  assert.deepEqual(headerBadge(-2, false), { kind: 'none', value: '' })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `headerBadge` is not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```js
// src/utils/headerBadge.js
// What the mobile hamburger badge shows. Bid alerts (you're being outbid) are
// the most urgent signal, so they win over the What's-new "unseen" dot. Mirrors
// the count formatting AccountButton uses for .bid-alert-badge (9+ clamp).
export function headerBadge(alertCount, hasUnseen) {
  const count = Number.isFinite(alertCount) && alertCount > 0 ? alertCount : 0
  if (count > 0) return { kind: 'count', value: count > 9 ? '9+' : String(count) }
  if (hasUnseen) return { kind: 'dot', value: '' }
  return { kind: 'none', value: '' }
}
```

- [ ] **Step 4: Run test + type-check to verify it passes**

Run: `npm run test:unit && npm run type-check`
Expected: PASS (all 5 headerBadge tests; clean tsc). `checkJs` is on — if tsc
complains about `headerBadge.js`, add `// @ts-nocheck` at the top (repo
convention for JS that fights the checker).

- [ ] **Step 5: Commit**

```bash
git add src/utils/headerBadge.js src/utils/headerBadge.test.js
git commit -m "feat: headerBadge helper for hamburger notification priority"
```

---

### Task 2: Extract `AccountMenuBody` from `AccountButton`

This is a behavior-preserving refactor so the drawer and the desktop dropdown share one copy of the account logic. The logged-in dropdown's inner markup + password-change state move into `AccountMenuBody`; `AccountButton` keeps the icon button + open/close + the logged-out "Sign in" button.

**Files:**
- Create: `src/components/AccountMenuBody.jsx`
- Modify: `src/components/AccountButton.jsx`
- Test: `src/components/AccountMenuBody.vitest.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/AccountMenuBody.vitest.jsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AccountMenuBody } from './AccountMenuBody.jsx'

function makeAuth(over = {}) {
  return { available: true, user: { email: 'a@b.com' }, signOut: vi.fn(), changePassword: vi.fn(), ...over }
}

describe('AccountMenuBody', () => {
  it('shows the user email', () => {
    render(<AccountMenuBody auth={makeAuth()} cannonBids={null} />)
    expect(screen.getByText('a@b.com')).toBeInTheDocument()
  })

  it('sign out calls auth.signOut then onAfterAction', () => {
    const auth = makeAuth()
    const onAfterAction = vi.fn()
    render(<AccountMenuBody auth={auth} cannonBids={null} onAfterAction={onAfterAction} />)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalledOnce()
    expect(onAfterAction).toHaveBeenCalledOnce()
  })

  it('Link Cannon\'s account fires the callback and closes', () => {
    const onCannonLinkClick = vi.fn()
    const onAfterAction = vi.fn()
    render(<AccountMenuBody auth={makeAuth()} cannonBids={{ linked: false }} onCannonLinkClick={onCannonLinkClick} onAfterAction={onAfterAction} />)
    fireEvent.click(screen.getByRole('menuitem', { name: "Link Cannon's account" }))
    expect(onCannonLinkClick).toHaveBeenCalledOnce()
    expect(onAfterAction).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest`
Expected: FAIL — `AccountMenuBody` module missing.

- [ ] **Step 3: Create `AccountMenuBody.jsx`**

Move the logged-in dropdown internals out of `AccountButton`. The component owns the password-change state and renders the same markup/classnames as today. `onAfterAction` is invoked after sign-out and after Cannon's link (the dropdown passed `() => setOpen(false)`; the drawer will pass `onClose`).

```jsx
// src/components/AccountMenuBody.jsx
// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

// The logged-in account menu items, shared by the desktop dropdown
// (AccountButton) and the mobile NavDrawer. Owns the change-password flow.
// `onAfterAction` lets the container (popover / drawer) close itself after an
// action that should dismiss it (sign out, Cannon's link).
export function AccountMenuBody({ auth, cannonBids, onCannonLinkClick, onAfterAction }) {
  const [changing, setChanging] = useState(false)
  const [newPass, setNewPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [passError, setPassError] = useState('')
  const [passNotice, setPassNotice] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (changing) inputRef.current?.focus() }, [changing])

  const handleChangePassword = useCallback(async (e) => {
    e.preventDefault()
    setBusy(true)
    setPassError('')
    const result = await auth.changePassword(newPass)
    setBusy(false)
    if (result?.error) { setPassError(result.error); return }
    setPassNotice('Password updated.')
    setNewPass('')
    setTimeout(() => {
      setChanging(false)
      setPassNotice('')
      onAfterAction?.()
    }, 1500)
  }, [auth, newPass, onAfterAction])

  return (
    <>
      <div className="account-dropdown-email" title={auth.user.email}>
        {auth.user.email}
      </div>
      <hr className="account-dropdown-divider" />
      {cannonBids && (
        <button
          type="button"
          className={`account-dropdown-item${cannonBids.linked ? ' account-dropdown-item--cannon-linked' : ''}`}
          role="menuitem"
          onClick={() => { onAfterAction?.(); onCannonLinkClick?.() }}
        >
          {cannonBids.linked ? `Cannon's ✓ (${cannonBids.username})` : "Link Cannon's account"}
        </button>
      )}
      {changing ? (
        <form className="account-change-pass-form" onSubmit={handleChangePassword}>
          <input
            ref={inputRef}
            type="password"
            className="account-change-pass-input"
            placeholder="New password"
            autoComplete="new-password"
            minLength={6}
            required
            value={newPass}
            onChange={e => setNewPass(e.target.value)}
          />
          {passError && <p className="account-dropdown-error">{passError}</p>}
          {passNotice && <p className="account-dropdown-notice">{passNotice}</p>}
          <div className="account-change-pass-actions">
            <button type="submit" className="account-dropdown-item account-dropdown-item--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="account-dropdown-item" onClick={() => setChanging(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <button type="button" className="account-dropdown-item" role="menuitem" onClick={() => setChanging(true)}>
            Change password
          </button>
          <button type="button" className="account-dropdown-item" role="menuitem" onClick={() => { onAfterAction?.(); auth.signOut() }}>
            Sign out
          </button>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 4: Rewrite `AccountButton.jsx` to use it**

Keep the icon button, open/close, outside-click, and logged-out branch. Replace the dropdown internals (current lines ~85-142) with `<AccountMenuBody>`. Remove the now-unused password-change state from `AccountButton` (`changing`, `newPass`, `busy`, `passError`, `passNotice`, `inputRef`, `handleChangePassword`, and the `inputRef` focus effect). The dropdown becomes:

```jsx
{open && (
  <div className="account-dropdown" role="menu">
    <AccountMenuBody
      auth={auth}
      cannonBids={cannonBids}
      onCannonLinkClick={onCannonLinkClick}
      onAfterAction={() => setOpen(false)}
    />
  </div>
)}
```

`openDropdown` simplifies to `setOpen(v => !v)`. Add `import { AccountMenuBody } from './AccountMenuBody.jsx'`. The logged-out "Sign in" branch (lines 149-158) is unchanged.

- [ ] **Step 5: Run tests + lint to verify pass**

Run: `npm run test:vitest && npm run lint`
Expected: PASS — AccountMenuBody tests green, no eslint errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/AccountMenuBody.jsx src/components/AccountMenuBody.vitest.jsx src/components/AccountButton.jsx
git commit -m "refactor: extract AccountMenuBody for reuse in drawer + dropdown"
```

---

### Task 3: `NavDrawer` component

**Files:**
- Create: `src/components/NavDrawer.jsx`
- Test: `src/components/NavDrawer.vitest.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/NavDrawer.vitest.jsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NavDrawer } from './NavDrawer.jsx'

const loggedOutAuth = { available: true, user: null }
const loggedInAuth = { available: true, user: { email: 'a@b.com' }, signOut: vi.fn(), changePassword: vi.fn() }

function baseProps(over = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onImageSearch: vi.fn(),
    onSwipe: vi.fn(),
    onTutorial: vi.fn(),
    onWhatsNew: vi.fn(),
    whatsNewUnseen: false,
    theme: 'light',
    onToggleTheme: vi.fn(),
    auth: loggedOutAuth,
    cannonBids: null,
    onSignInClick: vi.fn(),
    onCannonLinkClick: vi.fn(),
    ...over,
  }
}

describe('NavDrawer', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<NavDrawer {...baseProps({ open: false })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('logged out shows a Sign in action that fires and closes', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(p.onSignInClick).toHaveBeenCalledOnce()
    expect(p.onClose).toHaveBeenCalledOnce()
  })

  it('logged in shows the account email', () => {
    render(<NavDrawer {...baseProps({ auth: loggedInAuth })} />)
    expect(screen.getByText('a@b.com')).toBeInTheDocument()
  })

  it('a utility action fires its callback and closes the drawer', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search by photo' }))
    expect(p.onImageSearch).toHaveBeenCalledOnce()
    expect(p.onClose).toHaveBeenCalledOnce()
  })

  it('theme toggle fires onToggleTheme but does NOT close the drawer', () => {
    const p = baseProps()
    render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByRole('button', { name: /theme/i }))
    expect(p.onToggleTheme).toHaveBeenCalledOnce()
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('backdrop click and Escape both close', () => {
    const p = baseProps()
    const { rerender } = render(<NavDrawer {...p} />)
    fireEvent.click(screen.getByTestId('nav-drawer-overlay'))
    expect(p.onClose).toHaveBeenCalledOnce()
    rerender(<NavDrawer {...baseProps({ onClose: p.onClose })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })

  it('What\'s new shows the New badge only when unseen', () => {
    const { rerender } = render(<NavDrawer {...baseProps({ whatsNewUnseen: true })} />)
    expect(screen.getByText('New')).toBeInTheDocument()
    rerender(<NavDrawer {...baseProps({ whatsNewUnseen: false })} />)
    expect(screen.queryByText('New')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest`
Expected: FAIL — `NavDrawer` module missing.

- [ ] **Step 3: Implement `NavDrawer.jsx`**

Notes: clicking the panel must not bubble to the overlay (`stopPropagation`). Each action row calls `onClose()` then its handler (every action opens its own modal/overlay). Theme + trivia are the exceptions: they stay open. Escape listener + body scroll lock live in a `useEffect` gated on `open`. Render `<ArsenalTrivia>` inline for the trivia row.

```jsx
// src/components/NavDrawer.jsx
// @ts-nocheck
import { useEffect } from 'react'
import { AccountMenuBody } from './AccountMenuBody.jsx'
import { ArsenalTrivia } from './ArsenalTrivia.jsx'

export function NavDrawer({
  open, onClose,
  onImageSearch, onSwipe, onTutorial, onWhatsNew, whatsNewUnseen,
  theme, onToggleTheme,
  auth, cannonBids, onSignInClick, onCannonLinkClick,
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  // Actions that open their own overlay should dismiss the drawer first.
  const act = (fn) => () => { onClose(); fn?.() }

  return (
    <div className="nav-drawer-overlay" data-testid="nav-drawer-overlay" onClick={onClose}>
      <div
        className="nav-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nav-drawer-header">
          <span className="nav-drawer-title">Menu</span>
          <button type="button" className="nav-drawer-close" onClick={onClose} aria-label="Close menu">✕</button>
        </div>

        <div className="nav-drawer-body">
          <section className="nav-drawer-section">
            {auth.user ? (
              <AccountMenuBody
                auth={auth}
                cannonBids={cannonBids}
                onCannonLinkClick={onCannonLinkClick}
                onAfterAction={onClose}
              />
            ) : (
              <button type="button" className="nav-drawer-item" onClick={act(onSignInClick)}>
                Sign in
              </button>
            )}
          </section>

          <hr className="nav-drawer-divider" />

          <section className="nav-drawer-section">
            <button type="button" className="nav-drawer-item" onClick={act(onImageSearch)}>
              <span className="nav-drawer-icon" aria-hidden="true">📷</span> Search by photo
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onSwipe)}>
              <span className="nav-drawer-icon" aria-hidden="true">⇄</span> Swipe to review
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onTutorial)}>
              <span className="nav-drawer-icon" aria-hidden="true">?</span> How to use this site
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onWhatsNew)}>
              <span className="nav-drawer-icon" aria-hidden="true">✨</span> What's new
              {whatsNewUnseen && <span className="nav-drawer-new-badge">New</span>}
            </button>
            <div className="nav-drawer-item nav-drawer-item--trivia">
              <span className="nav-drawer-icon" aria-hidden="true">⚽</span>
              <ArsenalTrivia />
            </div>
          </section>

          <hr className="nav-drawer-divider" />

          <section className="nav-drawer-section">
            <button type="button" className="nav-drawer-item" onClick={onToggleTheme}>
              <span className="nav-drawer-icon" aria-hidden="true">{theme === 'dark' ? '☀' : '🌙'}</span>
              Theme: {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
```

> If the `<ArsenalTrivia>` markup makes the trivia-row accessible name awkward in tests, that's fine — no test asserts on trivia. Keep the inline-expand behavior (Task confirmed in spec). If it renders its own button label, leave it.

- [ ] **Step 4: Run tests + lint to verify pass**

Run: `npm run test:vitest && npm run lint`
Expected: PASS — all NavDrawer tests green.

- [ ] **Step 5: Commit**

```bash
git add src/components/NavDrawer.jsx src/components/NavDrawer.vitest.jsx
git commit -m "feat: NavDrawer mobile slide-in menu (account + utilities + theme)"
```

---

### Task 4: Wire the hamburger + drawer into `App.jsx`

**Files:**
- Modify: `src/App.jsx` (header block ~454-556; add a `useState`; add `import { NavDrawer } from './components/NavDrawer.jsx'` and `import { headerBadge } from './utils/headerBadge.js'`)

- [ ] **Step 1: Add state + derived badge near the other header state**

```jsx
const [navOpen, setNavOpen] = useState(false)
const bidAlertCount = auth.user ? (cannonBids?.unseenAlertCount ?? 0) : 0
const menuBadge = headerBadge(bidAlertCount, hasUnseen)
```

- [ ] **Step 2: Add the hamburger button as the first child of `.header-banner`**

Insert immediately after `<div className="header-banner">` (before the home button):

```jsx
<button
  type="button"
  className="header-menu-button"
  onClick={() => setNavOpen(true)}
  aria-label={bidAlertCount > 0 ? `Menu (${bidAlertCount} bid update${bidAlertCount > 1 ? 's' : ''})` : 'Menu'}
  aria-expanded={navOpen}
  aria-haspopup="dialog"
>
  <span className="header-menu-icon" aria-hidden="true">☰</span>
  {menuBadge.kind === 'count' && (
    <span className="header-menu-badge" aria-hidden="true">{menuBadge.value}</span>
  )}
  {menuBadge.kind === 'dot' && (
    <span className="header-menu-dot" aria-hidden="true" />
  )}
</button>
```

- [ ] **Step 3: Render `<NavDrawer>` just after the closing `</header>` (line ~556)**

```jsx
<NavDrawer
  open={navOpen}
  onClose={() => setNavOpen(false)}
  onImageSearch={() => setImageSearchOpen(true)}
  onSwipe={openSwipe}
  onTutorial={openTutorial}
  onWhatsNew={() => { captureEvent('whats_new_opened', { hasUnseen }); openWhatsNew() }}
  whatsNewUnseen={hasUnseen}
  theme={theme}
  onToggleTheme={toggleTheme}
  auth={auth}
  cannonBids={auth.user ? cannonBids : null}
  onSignInClick={() => setAuthOpen(true)}
  onCannonLinkClick={() => setCannonLinkOpen(true)}
/>
```

- [ ] **Step 4: Verify build + lint + type-check**

Run: `npm run lint && npm run type-check && npm run build`
Expected: PASS — clean lint, no type errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx
git commit -m "feat: render hamburger button + NavDrawer in header"
```

---

### Task 5: CSS — hamburger styles + mobile show/hide flip + drawer

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Hamburger button styles (desktop hidden, mobile shown)**

Add near the `.header-banner` rules (~line 113). The button is hidden by default; the mobile media query reveals it.

```css
.header-menu-button {
  display: none; /* desktop: no hamburger */
  position: relative;
  align-items: center;
  justify-content: center;
  width: 38px;
  min-height: 38px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: var(--radius);
  font-size: 1.1rem;
  cursor: pointer;
  flex-shrink: 0;
}
.header-menu-button:hover { background: var(--chip-bg); }
.header-menu-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 0.7rem;
  line-height: 16px;
  text-align: center;
  color: #fff;
  background: var(--accent);
  border-radius: 999px;
}
.header-menu-dot {
  position: absolute;
  top: -3px;
  right: -3px;
  width: 8px;
  height: 8px;
  background: var(--accent);
  border-radius: 50%;
}
```

- [ ] **Step 2: Mobile flip — show hamburger, hide actions row + inline account**

Inside the existing `@media (max-width: 700px)` block that styles `.header-banner` (~line 114), add the reveal; and replace the contents of the `.header-actions` mobile block (~lines 151-198) so the whole row is hidden on mobile. Also hide the inline account button on mobile (it lives in `.header-banner`).

```css
@media (max-width: 700px) {
  .header-menu-button { display: inline-flex; }
  /* Utility cluster + inline account now live in the drawer on mobile */
  .header-actions { display: none; }
  .header-banner > .account-menu,
  .header-banner > .account-button { display: none; }
}
```

Delete the now-dead mobile `.header-actions …` rules (old lines ~151-198) — they styled a row that no longer renders on mobile. Leave the desktop `.header-actions` base rule (~145-150) intact.

- [ ] **Step 3: Drawer overlay + panel (left slide-in), modeled on `.detail-overlay`**

Add a new block (near the detail-panel rules ~1955, or at end of file):

```css
.nav-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 400; /* above sticky header + detail panel */
  display: flex;
  justify-content: flex-start;
}
.nav-drawer-panel {
  position: relative;
  width: 280px;
  max-width: 85vw;
  height: 100vh;
  background: var(--bg);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  animation: nav-slide-in 0.22s ease-out;
  display: flex;
  flex-direction: column;
}
@keyframes nav-slide-in {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}
.nav-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.nav-drawer-title { font-weight: 600; }
.nav-drawer-close {
  background: none;
  border: none;
  font-size: 1.1rem;
  cursor: pointer;
  color: var(--text-muted, inherit);
  padding: 4px 8px;
}
.nav-drawer-body { padding: 6px; }
.nav-drawer-section { display: flex; flex-direction: column; }
.nav-drawer-divider { border: none; border-top: 1px solid var(--border); margin: 6px 10px; }
.nav-drawer-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 10px;
  background: none;
  border: none;
  border-radius: var(--radius);
  font-size: 0.95rem;
  text-align: left;
  color: inherit;
  cursor: pointer;
}
.nav-drawer-item:hover { background: var(--chip-bg); }
.nav-drawer-icon { width: 20px; text-align: center; flex-shrink: 0; }
.nav-drawer-new-badge {
  margin-left: auto;
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--chip-bg);
  color: var(--accent);
}
```

> Reuse existing variables (`--bg`, `--surface`, `--border`, `--chip-bg`, `--accent`, `--radius`). If `--text-muted` isn't defined, drop that line — `inherit` is fine.

- [ ] **Step 4: Verify drawer renders correctly at mobile width via the dev server**

Run: `npm run dev` then drive Playwright (see Task 6). Confirm: hamburger visible at 375px, hidden at 1280px; drawer slides from left; rows tappable.

- [ ] **Step 5: Commit**

```bash
git add src/index.css
git commit -m "style: hamburger button + left nav drawer; hide utility/account row on mobile"
```

---

### Task 6: Verify end-to-end + screenshots (gating)

Per `CLAUDE.md` ("UI Changes — Screenshot Before Merging"): capture mobile (375×667) and desktop (1280×800) and get explicit user approval before merge.

**Files:** none (verification only)

- [ ] **Step 1: Full test + quality gate**

Run: `npm run test:unit && npm run test:vitest && npm run lint && npm run type-check && npm run build`
Expected: all PASS.

- [ ] **Step 2: Capture screenshots with Playwright + dev server**

Start `npm run dev`. Capture, logged-out and logged-in if feasible:
- 375×667: header collapsed (hamburger visible, no utility row); drawer open.
- 1280×800: header unchanged (full inline utility row + account button; no hamburger).

Confirm visually: hamburger shows the bid count when alerts exist, the unseen dot otherwise; every drawer row works; Esc/backdrop/✕ close.

- [ ] **Step 3: Send screenshots to the user and WAIT for approval**

Do not merge before explicit approval. If changes requested, loop back to the relevant task.

- [ ] **Step 4: Commit any screenshot-driven fixes**

```bash
git add -A && git commit -m "fix: address screenshot review feedback"
```

---

### Task 7: Changelog entry

Per `CLAUDE.md`, ship a user-facing "What's new" line for visible changes. `src/data/changelog.js` is the source of truth (newest first; fresh, never-reused `id` per line); mirror into `CHANGELOG.md`.

**Files:**
- Modify: `src/data/changelog.js`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Prepend a dated entry to `changelog.js`**

The entry shape is `{ date, title, changes: [{ id, icon, text }] }` (read the
current top entry in `src/data/changelog.js` first and mirror it exactly —
note the per-line `icon` field). Add a new top entry dated `2026-06-15` with a
fresh, never-reused `id`, e.g.:

```js
{
  date: '2026-06-15',
  title: 'A tidier toolbar on phones',
  changes: [
    {
      id: 'mobile-hamburger-menu',
      icon: '☰',
      text: "On phones, the toolbar buttons now live in a tidy menu — tap the ☰ in the top-left. Your bid alerts show right on the menu button so you never miss being outbid.",
    },
  ],
},
```

- [ ] **Step 2: Mirror the line into `CHANGELOG.md`**

- [ ] **Step 3: Verify build (changelog feeds the app)**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/data/changelog.js CHANGELOG.md
git commit -m "docs(changelog): mobile hamburger menu"
```

---

## Notes / risks

- **Dead CSS removal (Task 5 Step 2):** the old mobile `.header-actions .account-icon-btn / .trivia-menu` rules styled controls that no longer render on mobile. Removing them is safe but double-check nothing else on mobile depended on those selectors.
- **ArsenalTrivia inside the drawer:** it's self-contained (owns its popover). Embedding it inline should "just work"; if its popover positions oddly inside the scrolling panel, that's a polish follow-up, not a blocker (spec lists this as the accepted approach).
- **No data/Supabase/scraper changes** — purely frontend.
- **Branch:** `claude/banner-hamburger-drawer` (already created off `origin/main`).
