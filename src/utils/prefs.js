// @ts-check
import { DEFAULT_LOCATION, DEFAULT_RADIUS_MILES } from './distance.ts'

export const STORAGE_KEY = 'gooners-preferences'

// Normalized category groups hidden out of the box. These are noise for this
// use case (the maintainers don't buy/sell firearms or vehicles off Cannon's),
// so they're excluded by default but re-enableable in the category filter.
// Exclusion is by normalized group, not rawCategory, because firearm lots carry
// wildly inconsistent rawCategory strings ("Daisy Pellet Gun", "AMMO", a stray
// "Basketball Trading Cards", …) that all normalize to the Firearms group.
export const DEFAULT_EXCLUDED_GROUPS = ['Firearms', 'Vehicles']

/**
 * @typedef {{
 *   includedCategories: string[],
 *   excludedCategories: string[],
 *   excludedGroups: string[],
 *   baselineExcludedGroups: string[],
 *   baselineExcludedCategories: string[],
 *   searchQuery: string,
 *   minPrice: number | null,
 *   maxPrice: number | null,
 *   minBids: number | null,
 *   maxBids: number | null,
 *   minBidders: number | null,
 *   maxBidders: number | null,
 *   minHours: number | null,
 *   maxHours: number | null,
 *   minProfit: number | null,
 *   localOnly: boolean,
 *   userLat: number,
 *   userLng: number,
 *   userLocationLabel: string,
 *   maxDistanceMiles: number | null,
 *   hasComp: boolean,
 *   hasCannonsComp: boolean,
 *   sort: string,
 *   viewMode: string,
 *   margin: number,
 * }} Prefs
 */

/** @type {Prefs} */
export const DEFAULT_PREFS = {
  includedCategories: [],
  excludedCategories: [],
  excludedGroups: [...DEFAULT_EXCLUDED_GROUPS],
  // Permanent per-user baseline: categories excluded by default, restored on "clear filters".
  // Separate from the session excludedGroups/excludedCategories so a temporary
  // session override doesn't overwrite the user's standing preferences.
  baselineExcludedGroups: [...DEFAULT_EXCLUDED_GROUPS],
  baselineExcludedCategories: [],
  searchQuery: '',
  minPrice: null,
  maxPrice: null,
  minBids: null,
  maxBids: null,
  minBidders: null,
  maxBidders: null,
  minHours: null,
  maxHours: null,
  // Minimum estimated profit (eBay comp median − all-in cost) to keep a lot.
  // null = off. Lots can't clear a worthwhile margin below this get hidden.
  minProfit: null,
  localOnly: false,
  // Distance filter (Facebook-Marketplace style). Defaults to Richmond, VA +
  // 25 mi so the app opens on the Richmond area, as it did with the old toggle.
  // maxDistanceMiles = null means "Any distance" (filter off).
  userLat: DEFAULT_LOCATION.lat,
  userLng: DEFAULT_LOCATION.lng,
  userLocationLabel: DEFAULT_LOCATION.label,
  maxDistanceMiles: DEFAULT_RADIUS_MILES,
  hasComp: false,
  hasCannonsComp: false,
  sort: '',
  // Grid layout: 'grid' (masonry thumbnails) or 'compact' (thumbnail + details list).
  viewMode: 'grid',
  // Resale margin used by the max-bid calculator, as a percentage (matches DEFAULT_MARGIN in roiCalc.js)
  margin: 30,
}

/** @type {ReadonlyArray<keyof Prefs>} */
export const PERSISTED_KEYS = [
  'includedCategories',
  'excludedCategories',
  'excludedGroups',
  'baselineExcludedGroups',
  'baselineExcludedCategories',
  'minPrice',
  'maxPrice',
  'minBids',
  'maxBids',
  'minBidders',
  'maxBidders',
  'minHours',
  'maxHours',
  'minProfit',
  'localOnly',
  'userLat',
  'userLng',
  'userLocationLabel',
  'maxDistanceMiles',
  'hasComp',
  'hasCannonsComp',
  'sort',
  'viewMode',
  'margin',
]

// An "Ends within" upper bound of 0 (or less, or NaN) can only ever match an
// item ending at this exact instant — time-remaining is otherwise always > 0 —
// so it silently hides the entire grid. It's never a useful filter, and because
// maxHours persists to localStorage and the maxHrs URL param, a stray 0 stays
// stuck across reloads. Normalize it back to null ("no upper bound").
/** @param {Prefs} prefs */
export function sanitizePrefs(prefs) {
  if (prefs.maxHours != null && !(prefs.maxHours > 0)) {
    return { ...prefs, maxHours: null }
  }
  return prefs
}

// Project a full prefs object down to just the persisted slice — the exact
// shape that round-trips through localStorage and the cloud `filter_preferences`
// row. searchQuery and other non-persisted fields are dropped.
/** @param {Prefs} prefs */
export function pickPersistedPrefs(prefs) {
  return /** @type {Prefs} */ (Object.fromEntries(PERSISTED_KEYS.map(k => [k, prefs[k]])))
}

// Normalize an arbitrary (e.g. cloud-loaded, possibly stale-schema) prefs blob
// into a clean persisted slice: defaults fill missing/legacy keys, unknown keys
// are dropped, and sanitizePrefs strips a stuck maxHours. Used when applying a
// cloud preferences row so a new field added since the row was written takes
// its default rather than going undefined.
/** @param {Partial<Prefs> | null | undefined} incoming */
export function normalizePersistedPrefs(incoming) {
  const merged = { ...DEFAULT_PREFS }
  if (incoming) {
    Object.assign(merged, Object.fromEntries(
      PERSISTED_KEYS.filter(k => incoming[k] !== undefined).map(k => [k, incoming[k]])
    ))
  }
  return pickPersistedPrefs(sanitizePrefs(merged))
}

export function loadPrefs() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return sanitizePrefs({ ...DEFAULT_PREFS, ...JSON.parse(stored) })
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_PREFS }
}

/** @param {Prefs} prefs */
export function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(PERSISTED_KEYS.map(k => [k, prefs[k]]))))
  } catch {
    // ignore
  }
}
