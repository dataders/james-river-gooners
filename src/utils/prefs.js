export const STORAGE_KEY = 'gooners-preferences'

export const DEFAULT_PREFS = {
  includedCategories: [],
  excludedCategories: [],
  searchQuery: '',
  minPrice: null,
  maxPrice: null,
  minBids: null,
  maxBids: null,
  minHours: null,
  maxHours: null,
  localOnly: false,
}

const PERSISTED_KEYS = [
  'includedCategories',
  'excludedCategories',
  'minPrice',
  'maxPrice',
  'minBids',
  'maxBids',
  'minHours',
  'maxHours',
  'localOnly',
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
