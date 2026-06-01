import { useState, useCallback } from 'react'
import { loadPrefs, savePrefs } from '../utils/prefs'
import { syncUrlParam } from '../utils/urlState'

function loadInitialPrefs() {
  const saved = loadPrefs()
  const p = new URLSearchParams(window.location.search)
  const merged = { ...saved }
  if (p.has('q')) merged.searchQuery = p.get('q') || ''
  if (p.has('min')) merged.minPrice = Number(p.get('min'))
  if (p.has('max')) merged.maxPrice = Number(p.get('max'))
  if (p.has('minBids')) merged.minBids = Number(p.get('minBids'))
  if (p.has('maxBids')) merged.maxBids = Number(p.get('maxBids'))
  if (p.has('minHrs')) merged.minHours = Number(p.get('minHrs'))
  if (p.has('maxHrs')) merged.maxHours = Number(p.get('maxHrs'))
  if (p.has('cat')) merged.excludedCategories = p.getAll('cat')
  if (p.has('local')) merged.localOnly = p.get('local') === '1'
  if (p.has('hasComp')) merged.hasComp = p.get('hasComp') === '1'
  if (p.has('sort')) merged.sort = p.get('sort') || ''
  return merged
}

export function usePreferences() {
  const [prefs, setPrefs] = useState(loadInitialPrefs)

  const toggleIncluded = useCallback((category) => {
    setPrefs(prev => {
      const included = [...prev.includedCategories]
      const idx = included.indexOf(category)
      if (idx >= 0) {
        included.splice(idx, 1)
      } else {
        included.push(category)
      }
      const next = { ...prev, includedCategories: included }
      savePrefs(next)
      return next
    })
  }, [])

  const toggleExcluded = useCallback((category) => {
    setPrefs(prev => {
      const excluded = [...prev.excludedCategories]
      const idx = excluded.indexOf(category)
      if (idx >= 0) {
        excluded.splice(idx, 1)
      } else {
        excluded.push(category)
      }
      const next = { ...prev, excludedCategories: excluded }
      savePrefs(next)
      syncUrlParam('cat', next.excludedCategories)
      return next
    })
  }, [])

  const clearIncluded = useCallback(() => {
    setPrefs(prev => {
      const next = { ...prev, includedCategories: [] }
      savePrefs(next)
      return next
    })
  }, [])

  const hideAll = useCallback((allCategories) => {
    syncUrlParam('cat', allCategories)
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: [...allCategories] }
      savePrefs(next)
      return next
    })
  }, [])

  const showAll = useCallback(() => {
    syncUrlParam('cat', [])
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: [] }
      savePrefs(next)
      return next
    })
  }, [])

  // Isolate a single category: exclude every category except `keep`.
  const showOnly = useCallback((keep, allCategories) => {
    const excluded = allCategories.filter(c => c !== keep)
    syncUrlParam('cat', excluded)
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: excluded }
      savePrefs(next)
      return next
    })
  }, [])

  const setSearchQuery = useCallback((query) => {
    syncUrlParam('q', query)
    setPrefs(prev => ({ ...prev, searchQuery: query }))
  }, [])

  const setNumericPreference = useCallback((key, urlKey, value) => {
    syncUrlParam(urlKey, value)
    setPrefs(prev => {
      const next = { ...prev, [key]: value }
      savePrefs(next)
      return next
    })
  }, [])

  const setMinPrice = useCallback((value) => setNumericPreference('minPrice', 'min', value), [setNumericPreference])
  const setMaxPrice = useCallback((value) => setNumericPreference('maxPrice', 'max', value), [setNumericPreference])
  const setMinBids = useCallback((value) => setNumericPreference('minBids', 'minBids', value), [setNumericPreference])
  const setMaxBids = useCallback((value) => setNumericPreference('maxBids', 'maxBids', value), [setNumericPreference])
  const setMinHours = useCallback((value) => setNumericPreference('minHours', 'minHrs', value), [setNumericPreference])
  const setMaxHours = useCallback((value) => setNumericPreference('maxHours', 'maxHrs', value), [setNumericPreference])

  const setLocalOnly = useCallback((value) => {
    syncUrlParam('local', value)
    setPrefs(prev => {
      const next = { ...prev, localOnly: value }
      savePrefs(next)
      return next
    })
  }, [])

  const setHasComp = useCallback((value) => {
    syncUrlParam('hasComp', value)
    setPrefs(prev => {
      const next = { ...prev, hasComp: value }
      savePrefs(next)
      return next
    })
  }, [])

  const setSort = useCallback((value) => {
    syncUrlParam('sort', value)
    setPrefs(prev => {
      const next = { ...prev, sort: value }
      savePrefs(next)
      return next
    })
  }, [])

  return {
    ...prefs,
    toggleIncluded,
    toggleExcluded,
    clearIncluded,
    hideAll,
    showAll,
    showOnly,
    setSearchQuery,
    setMinPrice,
    setMaxPrice,
    setMinBids,
    setMaxBids,
    setMinHours,
    setMaxHours,
    setLocalOnly,
    setHasComp,
    setSort,
  }
}
