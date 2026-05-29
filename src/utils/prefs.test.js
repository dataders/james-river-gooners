import test from 'node:test'
import assert from 'node:assert/strict'

// Minimal localStorage mock (no DOM in Node)
function makeLocalStorage() {
  const store = {}
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = v },
    removeItem: (k) => { delete store[k] },
    clear: () => { for (const k in store) delete store[k] },
  }
}

globalThis.localStorage = makeLocalStorage()

// Import after setting up the mock so module-level code sees it
const { DEFAULT_PREFS, STORAGE_KEY, loadPrefs, savePrefs } = await import('./prefs.js')

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

test('savePrefs does not persist searchQuery', () => {
  localStorage.clear()
  savePrefs({ ...DEFAULT_PREFS, searchQuery: 'antique' })
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY))
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

test('loadPrefs handles corrupt storage gracefully', () => {
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'not valid json }{')
  assert.doesNotThrow(() => loadPrefs())
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS)
})
