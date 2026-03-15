import { useState, useCallback } from 'react'

const STORAGE_KEY = 'gooners-preferences'

const DEFAULT_PREFS = {
  includedCategories: [], // empty = all
  excludedCategories: [],
  searchQuery: '',
}

function loadPrefs() {
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

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      includedCategories: prefs.includedCategories,
      excludedCategories: prefs.excludedCategories,
    }))
  } catch {
    // ignore
  }
}

export function usePreferences() {
  const [prefs, setPrefs] = useState(loadPrefs)

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
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: [...allCategories] }
      savePrefs(next)
      return next
    })
  }, [])

  const showAll = useCallback(() => {
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: [] }
      savePrefs(next)
      return next
    })
  }, [])

  const setSearchQuery = useCallback((query) => {
    setPrefs(prev => ({ ...prev, searchQuery: query }))
  }, [])

  return {
    ...prefs,
    toggleExcluded,
    hideAll,
    showAll,
    setSearchQuery,
  }
}
