# Zip-code distance filter — design

**Date:** 2026-06-21
**Status:** Approved (pending spec review + implementation plan)

## Problem

The aggregator now includes auctions from areas outside Richmond (HiBid companies
in Chesapeake/Cumberland/Powhatan, plus farther sources). The only location
control today is a binary **"Richmond area only"** checkbox driven by
`src/utils/locality.js` — a hard-coded `FAR_KEYWORDS` blacklist matched against the
auction *title*. That doesn't scale: it has no notion of *how far* an auction is,
can't express "show me everything within 50 miles," and silently mis-classifies any
auction whose title doesn't happen to mention a known far-away city.

We want a Facebook-Marketplace-style location filter: the user sets a location
(zip code or "use my current location") and a radius, and the grid shows only
auctions within that radius.

## Goals

- Every auction carries real coordinates, resolved at scrape time.
- The user sets their location (zip or geolocation) + a radius; the grid filters by
  great-circle distance.
- Out of the box (no user action) the app opens centered on **Richmond, VA** with a
  **25-mile** radius — preserving today's Richmond-area default experience.
- Geocoding gaps are caught **loudly in the scraper**, never silently shown/hidden in
  the browser.

## Non-goals (explicitly deferred)

- **Removing the "Richmond area only" toggle** and `locality.js`. That's a follow-up
  once this ships and is validated live (user's stated sequence). The toggle stays in
  this change; the Richmond+25mi default already supersedes it in practice.
- **A live map preview / radius circle** (the map in the FB screenshot).
- **City/neighborhood search-as-you-type autocomplete.** Zip + geolocation only.
- Per-lot / exact street-address precision. City-centroid precision is what a radius
  filter needs.

## Design overview

Three layers: (1) scraper resolves each auction to coordinates and gates on failure,
(2) Supabase carries the coordinates through to the browser, (3) the frontend lets the
user pick a location + radius and filters auctions by distance.

```
scraper: city/state string ──► geocode_cache.yml ──► lat/lng ──► WriteContext
                                      │ miss
                                      ▼
                              FAIL the run (flag the unmapped city)

Supabase lots: + auction_city, auction_state, auction_latitude, auction_longitude
       │  (full views + _card views expose the new columns)
       ▼
browser: Auction { ..., city, state, lat, lng }
       │
       ▼
useItemPipeline distance stage: haversine(user, auction) <= radius  (mirrors isLocal stage)
       ▲
preferencesStore: { userLat, userLng, userLocationLabel, maxDistanceMiles }
  defaults: Richmond, VA + 25 mi; URL-synced ?lat&lng&mi; zip→latlng via no-key API
```

---

## 1. Scraper — auction coordinates + hard gate

### 1a. Each source supplies a city/state string

The three scrapers each build a `WriteContext` (`scrape.py:431`,
`scrape_hibid.py:627`, `scrape_rasmus.py:547`). Add two fields to `WriteContext`
(`scraper/persist.py`): `auction_city: str` and `auction_state: str`.

- **Cannon's** (`scrape.py`): hard-code `("Richmond", "VA")` — Cannon's is a single
  Richmond house.
- **HiBid** (`scrape_hibid.py`): the company's `location:` field in
  `hibid_sources.yml` is already `"City, ST"` (e.g. `"Chesapeake, VA"`). Parse it into
  `(city, state)` at discovery and pass through. (This config is the source of truth;
  every company already has the field.)
- **Rasmus** (`scrape_rasmus.py`): the discovery path already fetches each auction's
  page `<title>`/`og:title` (`fetch_auction_meta`, ~line 330) and matches it against
  `location_keywords`. Extend that to also *extract* the matched city + state (the
  keyword that matched gives the city; default state `VA`, since the Richmond filter
  already constrains Rasmus to the VA area). Pass through to `WriteContext`.

### 1b. Central geocode + gate in `persist.py`

Geocoding and the gate live **once** in the shared write path, so all three sources
inherit identical behavior (same rationale as `write_read_model` being the single
write tail).

- New module `scraper/geocode.py` + committed data file `scraper/geocode_cache.yml`
  mapping normalized `"city, st"` → `{lat, lng}` (lower-cased, trimmed key). Seed it
  with every city currently present across the three sources (Richmond, Midlothian,
  Chesapeake, Cumberland, Powhatan, … — enumerate from `hibid_sources.yml` + Rasmus +
  Cannon's).
- `geocode.resolve(city, state) -> (lat, lng)`:
  1. Look up the normalized key in `geocode_cache.yml`. Hit → return.
  2. Miss → optionally call a **free, no-key** geocoder (US Census Geocoder,
     `geocoding.geo.census.gov`) to resolve and **append the result to
     `geocode_cache.yml`** (so local dev self-heals the cache; the new entry gets
     committed). This network step is best-effort.
  3. Still unresolved (cache miss **and** geocoder unavailable/failed, or missing
     city/state) → **raise** `GeocodeError`.
- In `write_read_model` (or a new `_stamp_auction_metadata` sub-step), call
  `geocode.resolve(ctx.auction_city, ctx.auction_state)` and stamp
  `auction_city / auction_state / auction_latitude / auction_longitude` onto every
  lot. A `GeocodeError` propagates and **fails that auction's scrape** — in
  `rescrape_all.py`'s `_scrape_source`, a failed source is already counted as a
  `failure` and surfaced, so the workflow exits non-zero with a clear message:
  `"auction <title> in 'Foo, ZZ' has no geocode — add it to geocode_cache.yml"`.

**Why a committed cache rather than always hitting an API:** CI must be deterministic
and offline-safe; a flaky geocoding API would make the *gate* itself flaky. The cache
is the source of truth in CI; the Census call is a local-dev convenience that fills new
entries. A genuinely new city → the run fails loudly and a human adds the
(deterministic) coordinate, which is exactly the requested "flag/fail" behavior.

### 1c. Tests

- `geocode.resolve` returns cached coords; raises on unmapped city (no network).
- `_lot_row` / stamping includes the four new fields.
- Parity: a fixture auction flows through `write_read_model` and the lots carry
  coords.

---

## 2. Supabase — carry coordinates to the browser

Additive migration `supabase/migrations/00NN_lot_location.sql`:

- `alter table lots add column auction_city text, add column auction_state text,
  add column auction_latitude numeric(9,6), add column auction_longitude numeric(9,6);`
- Recreate the four views to include the new columns:
  `public_active_lots` / `public_archived_lots` (full, `0007_lots.sql`) and
  `public_active_lots_card` / `public_archived_lots_card` (`0017_lots_card_views.sql`).
  Coordinates are tiny, so they ride in the `_card` views the grid reads.

Writer (`scraper/supabase_lots.py`): add the four fields to `_lot_row` (write) and
`_row_to_item` (read-back), mapping `auctionLatitude`↔`auction_latitude`, etc.

**Rollout (data-backed migration → "populate before merge", per CLAUDE.md):**

1. Apply the migration to the live project (additive; old frontend unaffected).
2. **Backfill existing auctions' coordinates.** A backfill derives each existing
   auction's `(city, state)` the same way live discovery does — HiBid by source slug →
   `hibid_sources.yml` location, Cannon's → Richmond, Rasmus by title — geocodes via the
   cache, and upserts the coords onto the stored `lots` rows. Runs from the PR branch
   (`gh workflow run … --ref <branch>`), so Supabase fills while `main` is untouched.
   If the backfill hits an unmapped city it fails the same way — seed the cache, re-run.
3. Verify coords populated (service-role count of non-null `auction_latitude`).
4. Merge → deploy; the new frontend reads columns that are already full.

---

## 3. Frontend — location picker + distance filter

### 3a. Normalizer + types

- `src/types.ts` `Auction`: add `city?: string`, `state?: string`, `lat: number`,
  `lng: number`.
- `auctionNormalize.js` `normalizeLotRow` / `normalizeRowsSupabase`: map the new
  columns; set `lat`/`lng` on the auction record (alongside `isLocal`, which stays).

### 3b. Distance util

- `src/utils/distance.js`: `haversineMiles(lat1, lng1, lat2, lng2) -> number`. Pure,
  unit-tested (known city-pair distances within tolerance).

### 3c. Preferences store

`preferencesStore.js` + `prefs.js` + `urlState.js`:

- New fields: `userLat`, `userLng`, `userLocationLabel` (e.g. `"Richmond, VA"` /
  `"Current location"`), `maxDistanceMiles`.
- **Defaults** (`DEFAULT_PREFS`): Richmond, VA centroid (`37.5407, -77.4360`),
  label `"Richmond, VA"`, `maxDistanceMiles: 25`.
- URL params (`URL_PARAMS`): `lat`, `lng`, `mi` (loaded/merged in `loadInitialPrefs`,
  synced via `setField`). `userLocationLabel` persists to localStorage but isn't a URL
  param (a shared link carries coords + radius; the label is cosmetic and re-derivable).
- Setters: `setUserLocation({ lat, lng, label })` (sets the three location fields in one
  `set()`), `setMaxDistanceMiles(v)`.
- Radius values: `25, 50, 100, 250, 500, null` where `null` = **"Any distance"**
  (disables the distance filter).

### 3d. Zip → coordinates

- `src/utils/geocodeZip.js`: `lookupZip(zip) -> { lat, lng, label }` via a free,
  no-key, CORS-enabled service (Zippopotam.us: `https://api.zippopotam.us/us/<zip>`,
  returns place name + lat/lng → label `"<place>, <ST>"`). Goes through
  `fetchJsonWithRetry` (`src/utils/net.js`); a 404 (invalid zip) returns null so the UI
  can show "zip not found." Results cached in `localStorage` (`gooners-zip-cache`) so a
  repeat zip is instant and offline.
- The Richmond default coords are baked into `DEFAULT_PREFS`, so first load needs **no**
  network call — the filter works offline immediately.

### 3e. UI — `LocationFilter` in `FilterPanel`

A compact control (its own labeled section in `FilterPanel.jsx`):

- **Location row:** read-only display of `userLocationLabel`, a zip `<input>`
  (5-digit, numeric), and a **📍 Use my location** button.
  - Zip entry → `lookupZip` → `setUserLocation`. Invalid zip → inline error, no change.
  - 📍 button → `navigator.geolocation.getCurrentPosition` → `setUserLocation({ lat, lng,
    label: 'Current location' })`. No reverse-geocode needed (we filter on coords).
    Handle denied/unavailable permission with an inline message; geolocation needs HTTPS
    (the deployed site is HTTPS; localhost is allowed).
- **Radius row:** `<select>` of `25 / 50 / 100 / 250 / 500 miles / Any distance`
  (default 25) → `setMaxDistanceMiles`.

### 3f. Filtering — `useItemPipeline` distance stage

Mirror the existing `isLocal` stage (`useItemPipeline.ts:90–107`), upstream so the
auctions list + category counts reflect it:

- `distanceOkAuctionIds`: when `maxDistanceMiles == null` (Any), all auctions pass;
  else the set of `auction.safeId` whose `haversineMiles(userLat, userLng, a.lat, a.lng)
  <= maxDistanceMiles`.
- `visibleAuctions` / `visibleItems` filter by that set (composed with the existing
  `localOnly` filter — both apply; `localOnly` defaults off).
- All inputs flow through `App.jsx` (`usePreferences()` → `useItemPipeline({...})`),
  matching the existing `localOnly` wiring.

### 3g. Active-filter chip

`ActiveFilters.jsx`: when `maxDistanceMiles != null`, show a chip
`"Within 25 mi of Richmond, VA"`; `onRemove` sets radius to **Any distance** (doesn't
reset the location). Since the distance filter is on by default, the chip renders on
first load — acceptable and informative (it tells the user why far auctions are hidden).
`clearAllFilters` in `App.jsx` resets radius to Any (or to the 25mi default — decide in
the plan; leaning "reset to default 25mi of Richmond" to match initial state).

---

## 4. Changelog

Add a dated entry to `src/data/changelog.js` (newest first, fresh per-line `id`) and
mirror into `CHANGELOG.md`: a user-facing line like *"Filter auctions by distance — set
your zip code (or use your current location) and a radius to see only nearby auctions."*

## 5. Screenshots before merge

Per CLAUDE.md, the new `LocationFilter` control is a visual change: capture Playwright
screenshots of `FilterPanel` at mobile (375×667) and desktop (1280×800) on the dev
server and get explicit approval before merging.

---

## Risks / open questions

- **Census geocoder coverage / availability.** Mitigated by the committed cache being
  the CI source of truth; the API is convenience-only.
- **Rasmus city extraction reliability.** Title parsing is heuristic; if a city can't be
  extracted the gate fires (correct, loud) — seed the cache / improve the parse.
- **Default-on filter hides far auctions silently-ish.** Mitigated by the always-visible
  "Within 25 mi of Richmond" chip + the "Any distance" option.
- **`clearAllFilters` semantics for location** — reset to default (25mi/Richmond) vs.
  "Any distance." Resolve in the implementation plan.
