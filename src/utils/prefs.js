export const STORAGE_KEY = 'gooners-preferences'

// Normalized category groups hidden out of the box. These are noise for this
// use case (the maintainers don't buy/sell firearms or vehicles off Cannon's),
// so they're excluded by default but re-enableable in the category filter.
// Exclusion is by normalized group, not rawCategory, because firearm lots carry
// wildly inconsistent rawCategory strings ("Daisy Pellet Gun", "AMMO", a stray
// "Basketball Trading Cards", …) that all normalize to the Firearms group.
export const DEFAULT_EXCLUDED_GROUPS = ['Firearms', 'Vehicles']

export const DEFAULT_PREFS = {
  includedCategories: [],
  excludedCategories: [],
  excludedGroups: [...DEFAULT_EXCLUDED_GROUPS],
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
  hasComp: false,
  hasCannonsComp: false,
  sort: '',
  // Resale margin used by the max-bid calculator, as a percentage (matches DEFAULT_MARGIN in roiCalc.js)
  margin: 30,
}

const PERSISTED_KEYS = [
  'includedCategories',
  'excludedCategories',
  'excludedGroups',
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
  'hasComp',
  'hasCannonsComp',
  'sort',
  'margin',
]

// An "Ends within" upper bound of 0 (or less, or NaN) can only ever match an
// item ending at this exact instant — time-remaining is otherwise always > 0 —
// so it silently hides the entire grid. It's never a useful filter, and because
// maxHours persists to localStorage and the maxHrs URL param, a stray 0 stays
// stuck across reloads. Normalize it back to null ("no upper bound").
export function sanitizePrefs(prefs) {
  if (prefs.maxHours != null && !(prefs.maxHours > 0)) {
    return { ...prefs, maxHours: null }
  }
  return prefs
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

export function savePrefs(prefs) {
  try {
    const toSave = {}
    for (const key of PERSISTED_KEYS) {
      toSave[key] = prefs[key]
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave))
  } catch {
    // ignore
  }
}
