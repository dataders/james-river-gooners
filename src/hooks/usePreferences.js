import { useState, useCallback } from 'react'
import { loadPrefs, savePrefs } from '../utils/prefs'

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

  const makeNumericSetter = (key) => (value) => {
    setPrefs(prev => {
      const next = { ...prev, [key]: value }
      savePrefs(next)
      return next
    })
  }

  const setMinPrice = useCallback(makeNumericSetter('minPrice'), [])
  const setMaxPrice = useCallback(makeNumericSetter('maxPrice'), [])
  const setMinBids = useCallback(makeNumericSetter('minBids'), [])
  const setMaxBids = useCallback(makeNumericSetter('maxBids'), [])
  const setMinHours = useCallback(makeNumericSetter('minHours'), [])
  const setMaxHours = useCallback(makeNumericSetter('maxHours'), [])

  const setLocalOnly = useCallback((value) => {
    setPrefs(prev => {
      const next = { ...prev, localOnly: value }
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
    setSearchQuery,
    setMinPrice,
    setMaxPrice,
    setMinBids,
    setMaxBids,
    setMinHours,
    setMaxHours,
    setLocalOnly,
  }
}
