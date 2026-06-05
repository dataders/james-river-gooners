export const STORAGE_KEY = 'gooners-preferences'

export const DEFAULT_PREFS = {
  includedCategories: [],
  excludedCategories: [],
  searchQuery: '',
  minPrice: null,
  maxPrice: null,
  minBids: null,
  maxBids: null,
  minBidders: null,
  maxBidders: null,
  minHours: null,
  maxHours: null,
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
  'minPrice',
  'maxPrice',
  'minBids',
  'maxBids',
  'minBidders',
  'maxBidders',
  'minHours',
  'maxHours',
  'localOnly',
  'hasComp',
  'hasCannonsComp',
  'sort',
  'margin',
]

export function loadPrefs() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...DEFAULT_PREFS, ...JSON.parse(stored) }
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
