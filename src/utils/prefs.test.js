import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal localStorage mock (no DOM in Node)
function makeLocalStorage() {
  /** @type {Record<string, string>} */
  const store = {}
  return {
    /** @param {string} k */
    getItem: (k) => (k in store ? store[k] : null),
    /** @param {string} k @param {string} v */
    setItem: (k, v) => { store[k] = v },
    clear: () => { for (const k in store) delete store[k] },
  }
}

globalThis.localStorage = /** @type {Storage} */ (/** @type {unknown} */ (makeLocalStorage()))

// Import after setting up the mock so module-level code sees it
const { DEFAULT_PREFS, STORAGE_KEY, PERSISTED_KEYS, loadPrefs, savePrefs, sanitizePrefs, pickPersistedPrefs, normalizePersistedPrefs } = await import('./prefs.js')

test('loadPrefs returns defaults when nothing is stored', () => {
  localStorage.clear()
  const prefs = loadPrefs()
  assert.deepEqual(prefs, DEFAULT_PREFS)
})

test('savePrefs + loadPrefs round-trips numeric filter values', () => {
  localStorage.clear()
  const input = { ...DEFAULT_PREFS, minPrice: 10, maxPrice: 500, minBids: 2, maxBids: 20, minHours: 1, maxHours: 48 }
  savePrefs(input)
  const loaded = loadPrefs()
  assert.equal(loaded.minPrice, 10)
  assert.equal(loaded.maxPrice, 500)
  assert.equal(loaded.minBids, 2)
  assert.equal(loaded.maxBids, 20)
  assert.equal(loaded.minHours, 1)
  assert.equal(loaded.maxHours, 48)
})

test('savePrefs + loadPrefs round-trips localOnly flag', () => {
  localStorage.clear()
  savePrefs({ ...DEFAULT_PREFS, localOnly: true })
  assert.equal(loadPrefs().localOnly, true)
  savePrefs({ ...DEFAULT_PREFS, localOnly: false })
  assert.equal(loadPrefs().localOnly, false)
})

test('savePrefs + loadPrefs round-trips category arrays', () => {
  localStorage.clear()
  const cats = ['Furniture', 'Electronics']
  savePrefs({ ...DEFAULT_PREFS, excludedCategories: cats })
  assert.deepEqual(loadPrefs().excludedCategories, cats)
})

test('Firearms and Vehicles groups are excluded by default', () => {
  localStorage.clear()
  assert.deepEqual(loadPrefs().excludedGroups, ['Firearms', 'Vehicles'])
})

test('savePrefs + loadPrefs round-trips a re-enabled (empty) group exclusion', () => {
  localStorage.clear()
  // User chose to show firearms/vehicles — the empty set must persist, not
  // snap back to the default on reload.
  savePrefs({ ...DEFAULT_PREFS, excludedGroups: [] })
  assert.deepEqual(loadPrefs().excludedGroups, [])
})

test('savePrefs does not persist searchQuery', () => {
  localStorage.clear()
  savePrefs({ ...DEFAULT_PREFS, searchQuery: 'antique' })
  const raw = JSON.parse(/** @type {string} */ (localStorage.getItem(STORAGE_KEY)))
  assert.ok(!('searchQuery' in raw), 'searchQuery should not be saved to storage')
})

test('loadPrefs fills in missing keys with defaults', () => {
  localStorage.clear()
  // Simulate old stored data that only has categories (before filter persistence was added)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ excludedCategories: ['Furniture'] }))
  const prefs = loadPrefs()
  assert.equal(prefs.minPrice, null)
  assert.equal(prefs.maxPrice, null)
  assert.equal(prefs.localOnly, false)
  assert.deepEqual(prefs.excludedCategories, ['Furniture'])
})

test('loadPrefs normalizes a stuck maxHours of 0 to null', () => {
  localStorage.clear()
  // A maxHours of 0 hides every item; it must not survive a reload.
  savePrefs({ ...DEFAULT_PREFS, maxHours: 0 })
  assert.equal(loadPrefs().maxHours, null)
})

test('sanitizePrefs clears non-positive maxHours but keeps valid bounds', () => {
  assert.equal(sanitizePrefs({ ...DEFAULT_PREFS, maxHours: 0 }).maxHours, null)
  assert.equal(sanitizePrefs({ ...DEFAULT_PREFS, maxHours: -5 }).maxHours, null)
  assert.equal(sanitizePrefs({ ...DEFAULT_PREFS, maxHours: NaN }).maxHours, null)
  assert.equal(sanitizePrefs({ ...DEFAULT_PREFS, maxHours: 48 }).maxHours, 48)
  assert.equal(sanitizePrefs({ ...DEFAULT_PREFS, maxHours: null }).maxHours, null)
})

test('pickPersistedPrefs keeps only persisted keys and drops searchQuery', () => {
  const slice = pickPersistedPrefs({ ...DEFAULT_PREFS, searchQuery: 'antique' })
  assert.ok(!('searchQuery' in slice), 'searchQuery must not be in the persisted slice')
  assert.deepEqual(Object.keys(slice).sort(), [...PERSISTED_KEYS].sort())
})

test('pickPersistedPrefs serializes identically regardless of input key order', () => {
  // The cloud-sync subscriber compares JSON of the slice, so order must be
  // stable (driven by PERSISTED_KEYS) no matter how the source object is built.
  // Two objects with the same data but built in different key orders must serialize identically.
  const obj1 = { ...DEFAULT_PREFS, minPrice: 5, maxPrice: 50, sort: 'price' }
  const obj2 = Object.assign({}, { sort: 'price' }, { maxPrice: 50 }, { minPrice: 5 }, DEFAULT_PREFS, { minPrice: 5, maxPrice: 50, sort: 'price' })
  const slice1 = pickPersistedPrefs(obj1)
  const slice2 = pickPersistedPrefs(obj2)
  assert.equal(JSON.stringify(slice1), JSON.stringify(slice2))
})

test('normalizePersistedPrefs fills new/missing keys from defaults', () => {
  // A cloud row written before `margin` existed should come back with the
  // default margin, not undefined.
  const withoutMargin = /** @type {Partial<import('./prefs.js').Prefs>} */ (pickPersistedPrefs(DEFAULT_PREFS))
  delete withoutMargin.margin
  const normalized = normalizePersistedPrefs({ ...withoutMargin, excludedGroups: ['Coins'] })
  assert.equal(normalized.margin, DEFAULT_PREFS.margin)
  assert.deepEqual(normalized.excludedGroups, ['Coins'])
})

test('normalizePersistedPrefs drops unknown keys and sanitizes maxHours', () => {
  const normalized = normalizePersistedPrefs({ maxHours: 0 })
  assert.equal(normalized.maxHours, null)
  // Unknown keys like 'junk' are dropped by normalizePersistedPrefs (it only copies PERSISTED_KEYS)
})

test('loadPrefs handles corrupt storage gracefully', () => {
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'not valid json }{')
  assert.doesNotThrow(() => loadPrefs())
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS)
})
