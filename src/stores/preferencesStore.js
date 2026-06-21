// @ts-nocheck
import { create } from 'zustand'
import {
  loadPrefs,
  savePrefs,
  sanitizePrefs,
  normalizePersistedPrefs,
  DEFAULT_PREFS,
  DEFAULT_EXCLUDED_GROUPS,
} from '../utils/prefs'
import {
  syncUrlParam,
  readParam,
  readListParam,
  URL_PARAMS,
} from '../utils/urlState'

// Single source of truth for filter/layout preferences. Replaces the per-field
// useState soup in the old usePreferences: state lives here, persistence
// (localStorage) and URL sync run through ONE generic `setField` instead of 25
// near-identical setters, and components can subscribe to just the slices they
// render. `usePreferences` is now a thin selector shim over this store, so its
// public API (and every consumer) is unchanged.

// Per-field config: which URL param mirrors it (if any) and whether it persists
// to localStorage. This is the one place a field's wiring is declared.
const FIELD_CONFIG = {
  // searchQuery is URL-only (shareable), never persisted to localStorage.
  searchQuery: { url: URL_PARAMS.search, persist: false },
  minPrice: { url: URL_PARAMS.minPrice },
  maxPrice: { url: URL_PARAMS.maxPrice },
  minBids: { url: URL_PARAMS.minBids },
  maxBids: { url: URL_PARAMS.maxBids },
  minBidders: { url: URL_PARAMS.minBidders },
  maxBidders: { url: URL_PARAMS.maxBidders },
  minHours: { url: URL_PARAMS.minHours },
  maxHours: { url: URL_PARAMS.maxHours },
  minProfit: { url: URL_PARAMS.minProfit },
  localOnly: { url: URL_PARAMS.localOnly },
  hasComp: { url: URL_PARAMS.hasComp },
  hasCannonsComp: { url: URL_PARAMS.hasCannonsComp },
  sort: { url: URL_PARAMS.sort },
  // Personal layout/margin prefs: persisted, but not shareable filters.
  margin: {},
  viewMode: {},
}

// Merge persisted prefs with any URL overrides (a shared link wins on load).
function loadInitialPrefs() {
  const saved = loadPrefs()
  const merged = { ...saved }
  const num = (p) => Number(readParam(p))
  if (readParam(URL_PARAMS.search) !== null) merged.searchQuery = readParam(URL_PARAMS.search) || ''
  if (readParam(URL_PARAMS.minPrice) !== null) merged.minPrice = num(URL_PARAMS.minPrice)
  if (readParam(URL_PARAMS.maxPrice) !== null) merged.maxPrice = num(URL_PARAMS.maxPrice)
  if (readParam(URL_PARAMS.minBids) !== null) merged.minBids = num(URL_PARAMS.minBids)
  if (readParam(URL_PARAMS.maxBids) !== null) merged.maxBids = num(URL_PARAMS.maxBids)
  if (readParam(URL_PARAMS.minBidders) !== null) merged.minBidders = num(URL_PARAMS.minBidders)
  if (readParam(URL_PARAMS.maxBidders) !== null) merged.maxBidders = num(URL_PARAMS.maxBidders)
  if (readParam(URL_PARAMS.minHours) !== null) merged.minHours = num(URL_PARAMS.minHours)
  if (readParam(URL_PARAMS.maxHours) !== null) merged.maxHours = num(URL_PARAMS.maxHours)
  if (readParam(URL_PARAMS.minProfit) !== null) merged.minProfit = num(URL_PARAMS.minProfit)
  if (readListParam(URL_PARAMS.excludedCategories).length) merged.excludedCategories = readListParam(URL_PARAMS.excludedCategories)
  if (readListParam(URL_PARAMS.excludedGroups).length) merged.excludedGroups = readListParam(URL_PARAMS.excludedGroups)
  if (readParam(URL_PARAMS.localOnly) !== null) merged.localOnly = readParam(URL_PARAMS.localOnly) === '1'
  if (readParam(URL_PARAMS.hasComp) !== null) merged.hasComp = readParam(URL_PARAMS.hasComp) === '1'
  if (readParam(URL_PARAMS.hasCannonsComp) !== null) merged.hasCannonsComp = readParam(URL_PARAMS.hasCannonsComp) === '1'
  if (readParam(URL_PARAMS.sort) !== null) merged.sort = readParam(URL_PARAMS.sort) || ''
  // Re-sanitize after the URL merge so a stray ?maxHrs=0 can't blank the grid.
  return sanitizePrefs(merged)
}

export const usePreferencesStore = create((set, get) => {
  // The one place a single field changes: update state, persist, mirror to URL.
  const setField = (key, value) => {
    set({ [key]: value })
    const cfg = FIELD_CONFIG[key] || {}
    if (cfg.persist !== false) savePrefs(get())
    if (cfg.url) syncUrlParam(cfg.url, value)
  }

  return {
    ...DEFAULT_PREFS,
    ...loadInitialPrefs(),

    setField,

    // Bulk-apply a persisted prefs blob (used when a logged-in user's cloud
    // `filter_preferences` row loads and takes over as authoritative). Replaces
    // every persisted field in ONE set() — so any subscriber fires once — then
    // mirrors to localStorage. Deliberately does NOT touch URL params: signing
    // in shouldn't rewrite the shareable link. Unknown/missing keys are
    // normalized to defaults.
    applyPrefs: (incoming) => {
      set(normalizePersistedPrefs(incoming))
      savePrefs(get())
    },

    // Named range/scalar setters — thin, stable wrappers over setField.
    setSearchQuery: (v) => setField('searchQuery', v),
    setMinPrice: (v) => setField('minPrice', v),
    setMaxPrice: (v) => setField('maxPrice', v),
    setMinBids: (v) => setField('minBids', v),
    setMaxBids: (v) => setField('maxBids', v),
    setMinBidders: (v) => setField('minBidders', v),
    setMaxBidders: (v) => setField('maxBidders', v),
    setMinHours: (v) => setField('minHours', v),
    setMaxHours: (v) => setField('maxHours', v),
    setMinProfit: (v) => setField('minProfit', v),
    setLocalOnly: (v) => setField('localOnly', v),
    setHasComp: (v) => setField('hasComp', v),
    setHasCannonsComp: (v) => setField('hasCannonsComp', v),
    setSort: (v) => setField('sort', v),
    setMargin: (v) => setField('margin', v),
    setViewMode: (v) => setField('viewMode', v),

    // --- Category include/exclude actions (ported verbatim in behaviour) ---
    toggleIncluded: (category) => {
      const included = [...get().includedCategories]
      const idx = included.indexOf(category)
      if (idx >= 0) included.splice(idx, 1)
      else included.push(category)
      set({ includedCategories: included })
      savePrefs(get())
    },

    toggleExcluded: (category) => {
      const excluded = [...get().excludedCategories]
      const idx = excluded.indexOf(category)
      if (idx >= 0) excluded.splice(idx, 1)
      else excluded.push(category)
      set({ excludedCategories: excluded })
      savePrefs(get())
      syncUrlParam(URL_PARAMS.excludedCategories, excluded)
    },

    clearIncluded: () => {
      set({ includedCategories: [] })
      savePrefs(get())
    },

    // Hide an entire normalized group (coarse switch — also catches future raw
    // categories that normalize into the group, unlike toggling each chip).
    hideGroup: (group) => {
      if (get().excludedGroups.includes(group)) return
      const excludedGroups = [...get().excludedGroups, group]
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      set({ excludedGroups })
      savePrefs(get())
    },

    // Fully reveal a group: drop it from the group exclusions and un-hide any of
    // its individual raw chips that were excluded.
    showGroup: (group, rawNames = []) => {
      const excludedGroups = get().excludedGroups.filter(g => g !== group)
      const rawSet = new Set(rawNames)
      const excludedCategories = get().excludedCategories.filter(c => !rawSet.has(c))
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      set({ excludedGroups, excludedCategories })
      savePrefs(get())
    },

    // Hide everything: exclude every group (covers all raw categories too).
    hideAll: (allGroups) => {
      syncUrlParam(URL_PARAMS.excludedGroups, allGroups)
      set({ excludedGroups: [...allGroups] })
      savePrefs(get())
    },

    // Reset session category filters to the user's saved baseline (their permanent
    // "always hide" list). Used by "Clear filters" and the category filter chip
    // dismiss — so clearing always lands on the user's standing preferences, not
    // on the hardcoded app defaults.
    showAll: () => {
      const { baselineExcludedGroups, baselineExcludedCategories } = get()
      const excludedGroups = [...baselineExcludedGroups]
      const excludedCategories = [...baselineExcludedCategories]
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      set({ excludedCategories, excludedGroups })
      savePrefs(get())
    },

    // Permanently update the baseline excluded groups and sync the active session
    // filter to match (so the change takes effect immediately in the grid).
    setBaselineExcludedGroups: (groups) => {
      set({ baselineExcludedGroups: groups, excludedGroups: groups })
      syncUrlParam(URL_PARAMS.excludedGroups, groups)
      savePrefs(get())
    },

    setBaselineExcludedCategories: (cats) => {
      set({ baselineExcludedCategories: cats, excludedCategories: cats })
      syncUrlParam(URL_PARAMS.excludedCategories, cats)
      savePrefs(get())
    },

    toggleBaselineGroup: (group) => {
      const groups = get().baselineExcludedGroups
      const next = groups.includes(group) ? groups.filter(g => g !== group) : [...groups, group]
      set({ baselineExcludedGroups: next, excludedGroups: next })
      syncUrlParam(URL_PARAMS.excludedGroups, next)
      savePrefs(get())
    },

    toggleBaselineCategory: (cat) => {
      const cats = get().baselineExcludedCategories
      const next = cats.includes(cat) ? cats.filter(c => c !== cat) : [...cats, cat]
      set({ baselineExcludedCategories: next, excludedCategories: next })
      syncUrlParam(URL_PARAMS.excludedCategories, next)
      savePrefs(get())
    },

    // --- Inline "promote a hidden category to always-hidden" (and restore) ---
    // Add to the permanent baseline WITHOUT clobbering the session excluded set.
    // The item is already session-hidden (that's why the promote UI was shown),
    // so the session filter and URL stay untouched; only the baseline gains it.
    // (Unlike toggleBaseline*, which forces the session to equal the baseline.)
    addBaselineGroup: (group) => {
      if (get().baselineExcludedGroups.includes(group)) return
      set({ baselineExcludedGroups: [...get().baselineExcludedGroups, group] })
      savePrefs(get())
    },
    addBaselineCategory: (cat) => {
      if (get().baselineExcludedCategories.includes(cat)) return
      set({ baselineExcludedCategories: [...get().baselineExcludedCategories, cat] })
      savePrefs(get())
    },
    // Restore: drop from the baseline AND un-hide from the live session (+ URL
    // sync), so "restore" means "show it again now and stop hiding it by default."
    removeBaselineGroup: (group) => {
      const baselineExcludedGroups = get().baselineExcludedGroups.filter(g => g !== group)
      const excludedGroups = get().excludedGroups.filter(g => g !== group)
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      set({ baselineExcludedGroups, excludedGroups })
      savePrefs(get())
    },
    removeBaselineCategory: (cat) => {
      const baselineExcludedCategories = get().baselineExcludedCategories.filter(c => c !== cat)
      const excludedCategories = get().excludedCategories.filter(c => c !== cat)
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      set({ baselineExcludedCategories, excludedCategories })
      savePrefs(get())
    },
    clearBaseline: () => {
      const { baselineExcludedGroups, baselineExcludedCategories } = get()
      const excludedGroups = get().excludedGroups.filter(g => !baselineExcludedGroups.includes(g))
      const excludedCategories = get().excludedCategories.filter(c => !baselineExcludedCategories.includes(c))
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      set({ baselineExcludedGroups: [], baselineExcludedCategories: [], excludedGroups, excludedCategories })
      savePrefs(get())
    },

    // Isolate a single raw category: exclude everything else (coarse group
    // exclusions for other groups, fine raw exclusions for siblings in `keep`'s
    // own group — so a 100-coin auction yields a few grp= params, not 100 cat=).
    showOnly: (keep, groupedCategories) => {
      const keepGroup = groupedCategories.find(g => g.rawCategories.some(c => c.name === keep))
      const excludedGroups = groupedCategories
        .filter(g => g !== keepGroup)
        .map(g => g.group)
      const excludedCategories = keepGroup
        ? keepGroup.rawCategories.map(c => c.name).filter(n => n !== keep)
        : []
      syncUrlParam(URL_PARAMS.excludedCategories, excludedCategories)
      syncUrlParam(URL_PARAMS.excludedGroups, excludedGroups)
      set({ excludedCategories, excludedGroups })
      savePrefs(get())
    },
  }
})