import { useState, useCallback } from 'react'
import { loadPrefs, savePrefs, sanitizePrefs, DEFAULT_EXCLUDED_GROUPS } from '../utils/prefs'
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
  if (p.has('minBidders')) merged.minBidders = Number(p.get('minBidders'))
  if (p.has('maxBidders')) merged.maxBidders = Number(p.get('maxBidders'))
  if (p.has('minHrs')) merged.minHours = Number(p.get('minHrs'))
  if (p.has('maxHrs')) merged.maxHours = Number(p.get('maxHrs'))
  if (p.has('minProfit')) merged.minProfit = Number(p.get('minProfit'))
  if (p.has('cat')) merged.excludedCategories = p.getAll('cat')
  if (p.has('grp')) merged.excludedGroups = p.getAll('grp')
  if (p.has('local')) merged.localOnly = p.get('local') === '1'
  if (p.has('hasComp')) merged.hasComp = p.get('hasComp') === '1'
  if (p.has('hasCannonsComp')) merged.hasCannonsComp = p.get('hasCannonsComp') === '1'
  if (p.has('sort')) merged.sort = p.get('sort') || ''
  // Re-sanitize after the URL merge so a stray ?maxHrs=0 can't blank the grid.
  return sanitizePrefs(merged)
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

  // Hide an entire normalized group (coarse switch — also catches future raw
  // categories that normalize into the group, unlike toggling each chip).
  const hideGroup = useCallback((group) => {
    setPrefs(prev => {
      if (prev.excludedGroups.includes(group)) return prev
      const excludedGroups = [...prev.excludedGroups, group]
      syncUrlParam('grp', excludedGroups)
      const next = { ...prev, excludedGroups }
      savePrefs(next)
      return next
    })
  }, [])

  // Fully reveal a group: drop it from the group exclusions and un-hide any of
  // its individual raw chips that were excluded.
  const showGroup = useCallback((group, rawNames = []) => {
    setPrefs(prev => {
      const excludedGroups = prev.excludedGroups.filter(g => g !== group)
      const rawSet = new Set(rawNames)
      const excludedCategories = prev.excludedCategories.filter(c => !rawSet.has(c))
      syncUrlParam('grp', excludedGroups)
      syncUrlParam('cat', excludedCategories)
      const next = { ...prev, excludedGroups, excludedCategories }
      savePrefs(next)
      return next
    })
  }, [])

  // Hide everything: exclude every group (covers all raw categories too).
  const hideAll = useCallback((allGroups) => {
    syncUrlParam('grp', allGroups)
    setPrefs(prev => {
      const next = { ...prev, excludedGroups: [...allGroups] }
      savePrefs(next)
      return next
    })
  }, [])

  // Bulk "show all" reveals every normally-browsable category but keeps the
  // standing default-hidden groups (Firearms/Vehicles) hidden — those stay
  // opt-in via their own group "show" button, so "show all" returns to the
  // default view rather than surfacing categories the user never browses.
  const showAll = useCallback(() => {
    const excludedGroups = [...DEFAULT_EXCLUDED_GROUPS]
    syncUrlParam('cat', [])
    syncUrlParam('grp', excludedGroups)
    setPrefs(prev => {
      const next = { ...prev, excludedCategories: [], excludedGroups }
      savePrefs(next)
      return next
    })
  }, [])

  // Isolate a single raw category: exclude everything else.
  // Uses coarse group exclusions for groups that don't contain `keep`, and fine
  // raw-category exclusions only for sibling cats in `keep`'s own group — so a
  // coin auction with 100 raw coin names produces a handful of grp= params
  // instead of 100 cat= params.
  // `groupedCategories` is the { group, rawCategories: [{ name }] }[] structure
  // from getGroupedCategories — already available at the FilterBar call site.
  const showOnly = useCallback((keep, groupedCategories) => {
    const keepGroup = groupedCategories.find(g => g.rawCategories.some(c => c.name === keep))
    const excludedGroups = groupedCategories
      .filter(g => g !== keepGroup)
      .map(g => g.group)
    const excludedCategories = keepGroup
      ? keepGroup.rawCategories.map(c => c.name).filter(n => n !== keep)
      : []
    syncUrlParam('cat', excludedCategories)
    syncUrlParam('grp', excludedGroups)
    setPrefs(prev => {
      const next = { ...prev, excludedCategories, excludedGroups }
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
  const setMinBidders = useCallback((value) => setNumericPreference('minBidders', 'minBidders', value), [setNumericPreference])
  const setMaxBidders = useCallback((value) => setNumericPreference('maxBidders', 'maxBidders', value), [setNumericPreference])
  const setMinHours = useCallback((value) => setNumericPreference('minHours', 'minHrs', value), [setNumericPreference])
  const setMaxHours = useCallback((value) => setNumericPreference('maxHours', 'maxHrs', value), [setNumericPreference])
  const setMinProfit = useCallback((value) => setNumericPreference('minProfit', 'minProfit', value), [setNumericPreference])

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

  const setHasCannonsComp = useCallback((value) => {
    syncUrlParam('hasCannonsComp', value)
    setPrefs(prev => {
      const next = { ...prev, hasCannonsComp: value }
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

  // Personal preference (not a shareable filter), so it persists but doesn't sync to the URL.
  const setMargin = useCallback((value) => {
    setPrefs(prev => {
      const next = { ...prev, margin: value }
      savePrefs(next)
      return next
    })
  }, [])

  return {
    ...prefs,
    toggleIncluded,
    toggleExcluded,
    clearIncluded,
    hideGroup,
    showGroup,
    hideAll,
    showAll,
    showOnly,
    setSearchQuery,
    setMinPrice,
    setMaxPrice,
    setMinBids,
    setMaxBids,
    setMinBidders,
    setMaxBidders,
    setMinHours,
    setMaxHours,
    setMinProfit,
    setLocalOnly,
    setHasComp,
    setHasCannonsComp,
    setSort,
    setMargin,
  }
}
