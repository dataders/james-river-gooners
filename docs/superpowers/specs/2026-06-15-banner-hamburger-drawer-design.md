# Banner hamburger drawer (mobile) — design spec

**Date:** 2026-06-15
**Status:** Proposed — for decision
**Author:** Anders + Claude

## Problem

On mobile (`<700px`) the header's utility cluster — six icon buttons rendered
in a single rounded bar — reads as cluttered. The buttons are
`📷 photo search · ⇄ swipe · ? help · ✨ what's new · ⚽ trivia · ☀ theme`
(`src/App.jsx:520-553`, `.header-actions`). They compete visually with the
controls a browser actually uses while scanning lots (search, Filters, layout,
Sort) without being part of that core loop.

## Goal

Collapse the six utility buttons behind a single hamburger button that opens a
left-sliding drawer listing them as labeled rows. Reduce banner noise without
hiding anything the user reaches for constantly.

## Scope decisions (confirmed with user)

- **Which controls move:** The utility cluster (the six buttons above) **and
  the account button** — sign-in when logged out; email + Link Cannon's account
  + change password + sign out when logged in. Search, the Filters/layout/Sort
  browse controls, and branding **stay in the banner**.
- **Bid-alert badge:** the account's red bid-alert count is **mirrored onto the
  hamburger**. The hamburger is the single notification point: it shows the bid
  count when alerts exist, and falls back to the What's-new unseen dot
  otherwise. Bids take priority — one badge, never both.
- **Viewports:** **Mobile only** (`@media (max-width: 700px)`). Desktop keeps
  the current inline row unchanged — there's horizontal room to spare.
- **Drawer side:** **Left** (classic nav convention). Hamburger sits at the
  far-left of row 1, before the Arsenal crest.

## Non-goals

- No change to desktop layout or to any of the six features themselves
  (modals/overlays they open are untouched).
- No change to search, Filters, layout toggle, Sort, or branding.
- No change to desktop account — the inline account button + dropdown stay.
- No change to auth itself (sign-in, sign-out, password, Cannon's link logic).
- Not a general nav redesign — this is a container move for six controls.

## Current state (reference)

- Header is inline in `src/App.jsx:453-554`; no separate header component.
- Styling is plain CSS in `src/index.css` (no CSS modules / Tailwind). The
  mobile header rules live under `@media (max-width: 700px)` (~lines 114-215);
  `.header-actions` is styled at ~145-198.
- The six utility controls and their triggers:
  | Icon | Control | Action | State it reflects |
  |------|---------|--------|-------------------|
  | 📷 | Image search | `setImageSearchOpen(true)` | none |
  | ⇄ | Swipe deck | `openSwipe` | none |
  | ? | Help / tutorial | `openTutorial` | none |
  | ✨ | What's new | `openWhatsNew` + telemetry | `hasUnseen` → red dot (`.has-unseen`) |
  | ⚽ | Arsenal trivia | self-contained popover (`ArsenalTrivia.jsx`) | own open/closed state |
  | ☀/🌙 | Theme | `toggleTheme` | `theme` ('dark'/'light') |
- Account: `AccountButton.jsx` (`src/components/AccountButton.jsx:1-158`)
  renders an icon / "Sign in" button plus a dropdown (email, Link Cannon's
  account, change password, sign out) and a red bid-alert badge — `alertCount`,
  derived from `cannonBids` — pinned top-right of the icon.
- Existing overlay patterns to model on: `ItemDetail` uses
  `.detail-overlay` + `.detail-panel` — a fixed slide-in panel (z-index 200,
  `slide-in` keyframe from the right). Auth/tutorial modals use z-index 300.

## Proposed design

### New component: `src/components/NavDrawer.jsx`

A presentational left-slide drawer. Props:

- `open: boolean`, `onClose: () => void`
- Action callbacks: `onImageSearch`, `onSwipe`, `onTutorial`, `onWhatsNew`
- `whatsNewUnseen: boolean` (drives the in-drawer "New" badge)
- `theme`, `onToggleTheme`
- Account: `auth`, `cannonBids`, `onSignInClick`, `onCannonLinkClick` — same
  inputs `AccountButton` takes today. The account menu renders as flat rows at
  the top of the drawer (see wiring below).
- Trivia: render `<ArsenalTrivia>` inline inside a drawer row (it manages its
  own open state), OR pass a trivia toggle — see "Open questions".

Structure (mirrors the mockup):

```
.nav-drawer-overlay        (backdrop, click closes, z-index ≥ 300)
  .nav-drawer-panel        (left, width ~240px, 100vh, slide-in from left)
    header: "Menu" + ✕ close
    account section (top):
      logged in:  avatar + email; "N bid alerts" line when alertCount > 0
                  Link Cannon's account  → onCannonLinkClick
                  Change password        → (existing auth handler)
                  Sign out               → (existing auth handler)
      logged out: Sign in                → onSignInClick
    ── divider ──
    utility rows:
      📷  Search by photo          → onImageSearch
      ⇄   Swipe to review          → onSwipe
      ?   How to use this site     → onTutorial
      ✨  What's new  [New badge]  → onWhatsNew   (badge when whatsNewUnseen)
      ⚽  Arsenal trivia           → inline expand
    ── divider ──
    ☀/🌙 Theme               [switch] → onToggleTheme
```

Each action row: tapping it performs the action **and closes the drawer**
(`onClose()` then the callback), since every action opens its own
modal/overlay. The theme row is the exception — it toggles in place and the
drawer stays open (it's a setting, not a navigation). Trivia also stays open
(it expands inline).

### Hamburger button (in banner)

- New `.header-menu-button` (Tabler-style `≡` / `ti-menu-2` glyph) added at the
  far-left of `.header-banner`, before the home crest.
- **Rendered only on mobile.** Approach: render it always in the JSX but hide
  with `display: none` by default and `display: inline-flex` inside the
  `@media (max-width: 700px)` block. The existing `.header-actions` row **and
  the account button** get the inverse treatment — visible on desktop,
  `display: none` on mobile (those controls now live only in the drawer on
  mobile). This keeps a single JSX tree and lets CSS decide per-viewport.
  *(Both the inline controls and the drawer mount on mobile but only one is
  visible — acceptable; the drawer panel is cheap.)*
- Single notification indicator: when `alertCount > 0` the hamburger shows the
  red **count** badge (the bid-alert count that lives on the account button
  today); otherwise it falls back to the What's-new unseen **dot**
  (`hasUnseen`). Bids take priority — `.header-menu-button` renders at most one
  badge.

### State / wiring (`src/App.jsx`)

- Add `const [navOpen, setNavOpen] = useState(false)`.
- Hamburger `onClick={() => setNavOpen(true)}`.
- Render `<NavDrawer open={navOpen} onClose={() => setNavOpen(false)} … />`,
  passing the same handlers the inline buttons already use
  (`setImageSearchOpen`, `openSwipe`, `openTutorial`, `openWhatsNew`,
  `theme`, `toggleTheme`, `hasUnseen`) plus the account inputs
  (`auth`, `cannonBids`, `setAuthOpen`, `setCannonLinkOpen`). The What's-new
  telemetry call (`captureEvent('whats_new_opened', …)`) moves into / is shared
  by the drawer path so analytics stay intact.
- Lift the bid-alert count out of `AccountButton` (or compute it in `App.jsx`
  from `cannonBids`) so both the hamburger badge and the drawer's account
  section can read the same `alertCount`.
- Render the account menu inside the drawer. Either give `AccountButton` an
  inline / `variant="drawer"` mode that renders its menu items as flat rows
  (no popover), or extract the menu items into a small shared component used by
  both the desktop dropdown and the drawer — reusing the existing handlers
  (`onSignInClick`, `onCannonLinkClick`, change password, sign out). Prefer
  whichever keeps the auth logic in one place.
- Leave the existing inline `.header-actions` JSX and `<AccountButton>` in place
  (desktop uses them; CSS hides them on mobile).

### Styling (`src/index.css`)

- Model `.nav-drawer-overlay` / `.nav-drawer-panel` on the existing
  `.detail-overlay` / `.detail-panel` rules, but slide from the **left**
  (new keyframe `nav-slide-in`: `translateX(-100%) → 0`).
- z-index ≥ 300 so it sits above the sticky header and detail panel.
- Reuse existing CSS variables (`--surface`, `--border`, `--text`,
  `--chip-bg`, `--accent`, `--radius`).

## Behavior & edge cases

- **Open:** tap hamburger → drawer slides in from left, backdrop fades in.
- **Close:** ✕ button, backdrop tap, `Esc` key, or selecting an action row.
- **Body scroll lock** while open (match whatever ItemDetail/modals do, or add
  `overflow: hidden` on `<body>` while `navOpen`).
- **Focus management:** move focus to the drawer on open, return it to the
  hamburger on close; trap focus within the panel; `aria-modal="true"`,
  `role="dialog"`, `aria-label="Menu"`. Hamburger gets
  `aria-expanded={navOpen}` + `aria-label="Menu"`.
- **Resize:** if the viewport crosses to ≥700px while the drawer is open, it's
  hidden by the media query; also call `setNavOpen(false)` on a resize past the
  breakpoint so reopening on mobile starts clean. (Low priority — CSS hiding it
  is sufficient functionally.)
- **What's-new dot:** appears on the hamburger when `hasUnseen`; the in-drawer
  row shows the "New" badge. Opening What's new clears it via existing logic.

## Open questions

1. **Trivia in a drawer.** `ArsenalTrivia` is a self-contained popover today.
   Options: (a) embed `<ArsenalTrivia>` as-is in a row and let it expand inline
   (simplest, recommended); (b) make the row open the trivia as its own small
   modal. Recommend (a).
2. **Theme as a row vs. switch.** Mockup shows a switch affordance. Could also
   be a plain row that flips the icon/label on tap. Recommend a labeled row
   with a small switch for clarity.
3. **Account in/out.** Confirmed **in** (mobile only) — account moves into the
   drawer. Its bid-alert badge is mirrored onto the hamburger (count when
   alerts exist, else the What's-new dot). Desktop keeps the inline account
   button + dropdown unchanged.

## Testing / acceptance

- **Screenshots before merge** (per CLAUDE.md): Playwright captures at mobile
  (375×667) and desktop (1280×800) of: (a) collapsed banner, (b) drawer open,
  (c) desktop unchanged. Send to user, wait for approval.
- Manual checks: each of the six actions still fires its modal/overlay from the
  drawer; theme toggles; sign-in / sign-out / Link Cannon's / change password
  all work from the drawer; the hamburger shows the bid-alert count when alerts
  exist and the What's-new dot otherwise; Esc/backdrop/✕ all close; desktop
  banner (incl. account button) is visually identical to today.
- `npm run lint` clean.

## Rough effort

Small–medium. One new component (~100-140 lines incl. CSS), wiring in
`App.jsx` (drawer state + lifting `alertCount`), a small refactor of
`AccountButton` so its menu renders inline inside the drawer, one new CSS block,
and a media-query show/hide flip for the hamburger / account / utility row.
No data, no Supabase, no scraper changes. No new dependencies.
