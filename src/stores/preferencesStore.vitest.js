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
