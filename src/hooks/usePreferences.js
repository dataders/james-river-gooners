import { useShallow } from 'zustand/react/shallow'
import { usePreferencesStore } from '../stores/preferencesStore'

// Thin selector shim over the Zustand preferences store. Preserves the exact
// public shape the old hook returned (state fields + named actions), so App and
// every filter component are unchanged — but the state, persistence, and URL
// sync now live in one store (src/stores/preferencesStore.js). Components that
// want render-scoped subscriptions can read the store directly with their own
// selector instead of taking the whole bag through props; this shim is the
// backwards-compatible default.
export function usePreferences() {
  return usePreferencesStore(
    useShallow((s) => ({
      // State
      includedCategories: s.includedCategories,
      excludedCategories: s.excludedCategories,
      excludedGroups: s.excludedGroups,
      searchQuery: s.searchQuery,
      minPrice: s.minPrice,
      maxPrice: s.maxPrice,
      minBids: s.minBids,
      maxBids: s.maxBids,
      minBidders: s.minBidders,
      maxBidders: s.maxBidders,
      minHours: s.minHours,
      maxHours: s.maxHours,
      minProfit: s.minProfit,
      localOnly: s.localOnly,
      hasComp: s.hasComp,
      hasCannonsComp: s.hasCannonsComp,
      sort: s.sort,
      viewMode: s.viewMode,
      margin: s.margin,
      // Actions (stable identities from the store)
      toggleIncluded: s.toggleIncluded,
      toggleExcluded: s.toggleExcluded,
      clearIncluded: s.clearIncluded,
      hideGroup: s.hideGroup,
      showGroup: s.showGroup,
      hideAll: s.hideAll,
      showAll: s.showAll,
      showOnly: s.showOnly,
      setSearchQuery: s.setSearchQuery,
      setMinPrice: s.setMinPrice,
      setMaxPrice: s.setMaxPrice,
      setMinBids: s.setMinBids,
      setMaxBids: s.setMaxBids,
      setMinBidders: s.setMinBidders,
      setMaxBidders: s.setMaxBidders,
      setMinHours: s.setMinHours,
      setMaxHours: s.setMaxHours,
      setMinProfit: s.setMinProfit,
      setLocalOnly: s.setLocalOnly,
      setHasComp: s.setHasComp,
      setHasCannonsComp: s.setHasCannonsComp,
      setSort: s.setSort,
      setMargin: s.setMargin,
      setViewMode: s.setViewMode,
    }))
  )
}
