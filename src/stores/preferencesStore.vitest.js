// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreferencesStore } from './preferencesStore.js'
import { STORAGE_KEY, DEFAULT_EXCLUDED_GROUPS } from '../utils/prefs.js'
import { URL_PARAMS } from '../utils/urlState.js'

function persisted() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
}
function urlParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  // Reset the singleton store to a clean baseline for each test.
  usePreferencesStore.setState({
    excludedCategories: [],
    excludedGroups: [...DEFAULT_EXCLUDED_GROUPS],
    searchQuery: '',
    minPrice: null,
    maxPrice: null,
    sort: '',
    localOnly: false,
    margin: 30,
  })
})

describe('preferencesStore', () => {
  it('setField updates state, persists to localStorage, and mirrors to the URL', () => {
    usePreferencesStore.getState().setMinPrice(50)
    expect(usePreferencesStore.getState().minPrice).toBe(50)
    expect(persisted().minPrice).toBe(50)
    expect(urlParam(URL_PARAMS.minPrice)).toBe('50')
  })

  it('searchQuery syncs to the URL but is never persisted to localStorage', () => {
    usePreferencesStore.getState().setSearchQuery('vintage chair')
    expect(usePreferencesStore.getState().searchQuery).toBe('vintage chair')
    expect(urlParam(URL_PARAMS.search)).toBe('vintage chair')
    expect('searchQuery' in persisted()).toBe(false)
  })

  it('margin persists but does not touch the URL', () => {
    usePreferencesStore.getState().setMargin(45)
    expect(persisted().margin).toBe(45)
    expect(urlParam('margin')).toBe(null)
  })

  it('toggleExcluded adds then removes a category and syncs the cat param', () => {
    const { toggleExcluded } = usePreferencesStore.getState()
    toggleExcluded('Coins')
    expect(usePreferencesStore.getState().excludedCategories).toContain('Coins')
    expect(new URLSearchParams(window.location.search).getAll(URL_PARAMS.excludedCategories)).toContain('Coins')
    toggleExcluded('Coins')
    expect(usePreferencesStore.getState().excludedCategories).not.toContain('Coins')
  })

  it('showAll clears category exclusions but keeps the default-hidden groups', () => {
    usePreferencesStore.setState({ excludedCategories: ['x'], excludedGroups: ['Coins', 'Firearms'] })
    usePreferencesStore.getState().showAll()
    expect(usePreferencesStore.getState().excludedCategories).toEqual([])
    expect(usePreferencesStore.getState().excludedGroups).toEqual([...DEFAULT_EXCLUDED_GROUPS])
  })
})

describe('baseline add/remove without clobbering the session set', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      excludedGroups: ['Art', 'Furniture'],
      excludedCategories: ['Coins'],
      baselineExcludedGroups: [],
      baselineExcludedCategories: [],
    })
  })

  it('addBaselineGroup unions into baseline and leaves the session as-is', () => {
    usePreferencesStore.getState().addBaselineGroup('Art')
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedGroups).toContain('Art')
    expect(s.excludedGroups).toEqual(['Art', 'Furniture']) // Furniture (session-only) not clobbered
    expect(persisted().baselineExcludedGroups).toContain('Art')
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
    expect(s.excludedGroups).toContain('Furniture') // sibling session hide survives
  })

  it('addBaselineCategory / removeBaselineCategory mirror the group behavior', () => {
    usePreferencesStore.getState().addBaselineCategory('Coins')
    expect(usePreferencesStore.getState().baselineExcludedCategories).toContain('Coins')
    usePreferencesStore.getState().removeBaselineCategory('Coins')
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedCategories).not.toContain('Coins')
    expect(s.excludedCategories).not.toContain('Coins')
  })

  it('clearBaseline empties the baseline and un-hides exactly the baseline items', () => {
    usePreferencesStore.setState({
      excludedGroups: ['Art', 'Furniture'],
      excludedCategories: ['Coins'],
      baselineExcludedGroups: ['Art'],
      baselineExcludedCategories: ['Coins'],
    })
    usePreferencesStore.getState().clearBaseline()
    const s = usePreferencesStore.getState()
    expect(s.baselineExcludedGroups).toEqual([])
    expect(s.baselineExcludedCategories).toEqual([])
    expect(s.excludedGroups).toEqual(['Furniture']) // non-baseline session hide kept
    expect(s.excludedCategories).toEqual([])
  })
})