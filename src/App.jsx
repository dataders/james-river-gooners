// @ts-nocheck
import { useState, useMemo, useEffect, useRef, useCallback, useDeferredValue, lazy, Suspense } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { useEbayComps } from './hooks/useEbayComps'
import { useCannonsComps } from './hooks/useCannonsComps'
import { useCategorySoldStats } from './hooks/useCategorySoldStats'
import { useEnrichment } from './hooks/useEnrichment'
import { useFavorites } from './hooks/useFavorites'
import { useIgnored } from './hooks/useIgnored'
import { useAuth } from './hooks/useAuth'
import { useCannonBids } from './hooks/useCannonBids'
import { usePreferences } from './hooks/usePreferences'
import { usePreferencesSync } from './hooks/usePreferencesSync'
import { useTheme } from './hooks/useTheme'
import { useHeaderVisible } from './hooks/useHeaderVisible'
import { useItemPipeline } from './hooks/useItemPipeline'
import { useFilterBounds } from './hooks/useFilterBounds'
import { useForYou } from './hooks/useForYou'
import { itemKey } from './utils/itemKey'
import { sortByForYou } from './utils/sort'
import { DEFAULT_LOCATION, DEFAULT_RADIUS_MILES } from './utils/distance'
import { overlayEnrichment } from './utils/enrichment'
import { syncUrlParam, pushUrlParam, readParam, readBoolParam, URL_PARAMS, ITEM_PANEL_STATE } from './utils/urlState'
import { captureEvent } from './lib/telemetry'
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { SortBar } from './components/SortBar'
import { SearchBar } from './components/SearchBar'
import { FilterPanel } from './components/FilterPanel'
import { ActiveFilters } from './components/ActiveFilters'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'
import { AccountButton } from './components/AccountButton'
import { NavDrawer } from './components/NavDrawer'
import { headerBadge } from './utils/headerBadge'
import { useTutorial } from './hooks/useTutorial'
import { useWhatsNew } from './hooks/useWhatsNew'

// Overlays that only mount behind a boolean toggle are code-split out of the
// main bundle and loaded on first open. They render as a no-op until then, so
// `<Suspense fallback={null}>` (the chunk arrives within a frame on open) keeps
// the JSX below unchanged in behaviour.
const lazyDefault = (loader, name) => lazy(() => loader().then(m => ({ default: m[name] })))
const SwipeDeck = lazyDefault(() => import('./components/SwipeDeck'), 'SwipeDeck')
const TutorialModal = lazyDefault(() => import('./components/TutorialModal'), 'TutorialModal')
const WhatsNewModal = lazyDefault(() => import('./components/WhatsNewModal'), 'WhatsNewModal')
const AuthModal = lazyDefault(() => import('./components/AuthModal'), 'AuthModal')
const CannonLinkModal = lazyDefault(() => import('./components/CannonLinkModal'), 'CannonLinkModal')
const MyBidsPanel = lazyDefault(() => import('./components/MyBidsPanel'), 'MyBidsPanel')
const ImageSearchModal = lazyDefault(() => import('./components/ImageSearchModal'), 'ImageSearchModal')
const FeedbackModal = lazyDefault(() => import('./components/FeedbackModal.tsx'), 'FeedbackModal')

export default function App() {
  // 'active' (live auctions only), 'both' (live + archived), or 'archived'
  // (past auctions only). 'archive=1' is the legacy URL value for 'both'.
  const [archiveMode, setArchiveMode] = useState(() => {
    const v = readParam(URL_PARAMS.archive)
    if (v === 'archived') return 'archived'
    if (v === 'both' || v === '1') return 'both'
    return 'active'
  })
  const {
    auctions,
    excludedAuctions,
    toggleAuction,
    showAllAuctions,
    showOnlyAuction,
    hideSource,
    showSource,
    items: rawItems,
    loading,
    loadComplete,
    error,
    archiveLoading,
    archiveError,
  } = useAuctionData(archiveMode)

  // Overlay backend enrichment (#155) onto items as early as possible, so every
  // downstream consumer (deep-link finder, filters, ✨ Identified toggle, cards)
  // sees the fresher Supabase copy when available and the NDJSON-baked fields
  // otherwise. Defined before the first `items` consumer below.
  const auctionSafeIds = useMemo(() => auctions.map(a => a.safeId), [auctions])
  const enrichmentByAuction = useEnrichment(auctionSafeIds)
  const items = useMemo(
    () => overlayEnrichment(rawItems, enrichmentByAuction),
    [rawItems, enrichmentByAuction]
  )

  // Global p99 slider bounds, fetched once up front so the price/bidding tracks
  // are correct from first paint instead of jumping as lots stream in.
  const filterBounds = useFilterBounds()

  const changeArchiveMode = useCallback((mode) => {
    setArchiveMode(mode)
    syncUrlParam('archive', mode === 'active' ? '' : mode)
    captureEvent('archive_mode_changed', { mode })
  }, [])

  const {
    excludedCategories,
    excludedGroups,
    baselineExcludedGroups,
    baselineExcludedCategories,
    searchQuery,
    minPrice,
    maxPrice,
    minBids,
    maxBids,
    minBidders,
    maxBidders,
    minHours,
    maxHours,
    localOnly,
    userLat,
    userLng,
    userLocationLabel,
    maxDistanceMiles,
    hasComp,
    hasCannonsComp,
    sort,
    viewMode,
    margin,
    toggleExcluded,
    hideGroup,
    showGroup,
    hideAll,
    showAll,
    showOnly,
    addBaselineGroup,
    addBaselineCategory,
    removeBaselineGroup,
    removeBaselineCategory,
    clearBaseline,
    setSearchQuery,
    setMinPrice,
    setMaxPrice,
    setMinBids,
    setMaxBids,
    setMinBidders,
    setMaxBidders,
    setMinHours,
    setMaxHours,
    setLocalOnly,
    setUserLocation,
    setMaxDistanceMiles,
    setHasComp,
    setHasCannonsComp,
    setSort,
    setViewMode,
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { tutorialOpen, openTutorial, closeTutorial } = useTutorial()
  const { whatsNewOpen, hasUnseen, seenIds, openWhatsNew, closeWhatsNew } = useWhatsNew()
  const auth = useAuth()
  // Sync the persisted filter config to the user's account (offline-first):
  // logged in, filters follow them across devices; logged out, this is a no-op
  // and localStorage stays the source of truth.
  usePreferencesSync(auth.user)
  const [authOpen, setAuthOpen] = useState(false)
  const [cannonLinkOpen, setCannonLinkOpen] = useState(false)
  const { favoriteIds, isFavorite, toggleFavorite, removeFavorite } = useFavorites(auth.user)
  const { ignoredIds, isIgnored, toggleIgnored, removeIgnored } = useIgnored(auth.user)
  const cannonBids = useCannonBids(auth.user)

  // Favorites and ignores are mutually exclusive: deciding one clears the other.
  const handleToggleFavorite = useCallback((item) => {
    if (!isFavorite(item) && isIgnored(item)) removeIgnored(item)
    toggleFavorite(item)
  }, [isFavorite, isIgnored, removeIgnored, toggleFavorite])

  const handleToggleIgnored = useCallback((item) => {
    if (!isIgnored(item) && isFavorite(item)) removeFavorite(item)
    toggleIgnored(item)
  }, [isIgnored, isFavorite, removeFavorite, toggleIgnored])

  const headerRef = useRef(null)
  const [headerHeight, setHeaderHeight] = useState(Infinity)
  useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setHeaderHeight(el.offsetHeight))
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const headerVisible = useHeaderVisible(headerHeight)

  // Store the selected item's stable key, not the object, so the open detail
  // panel always reflects the latest `items` (enrichment overlaying in, a
  // deadline tick re-deriving the list) instead of a frozen snapshot.
  const [selectedKey, setSelectedKey] = useState(null)
  const selectedItem = useMemo(
    () => (selectedKey ? items.find(i => itemKey(i) === selectedKey) ?? null : null),
    [selectedKey, items]
  )
  const [bestDeals, setBestDeals] = useState(() => readBoolParam(URL_PARAMS.bestDeals))
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const [showIgnoredOnly, setShowIgnoredOnly] = useState(false)
  const [myBidsPanelOpen, setMyBidsPanelOpen] = useState(false)
  const [showEnrichedOnly, setShowEnrichedOnly] = useState(false)
  const [swipeOpen, setSwipeOpen] = useState(false)
  const [swipeItems, setSwipeItems] = useState([])
  const [imageSearchOpen, setImageSearchOpen] = useState(false)
  // Mobile hamburger drawer (the utility cluster + account collapse into it on
  // small screens). The hamburger mirrors the account bid-alert count, falling
  // back to the What's-new unseen dot.
  const [navOpen, setNavOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const bidAlertCount = auth.user ? (cannonBids?.unseenAlertCount ?? 0) : 0
  const menuBadge = headerBadge(bidAlertCount, hasUnseen)
  const [filterOpen, setFilterOpen] = useState(() => {
    if (window.innerWidth < 1024) return false // mobile always starts closed
    const stored = localStorage.getItem('gooners-filter-open')
    if (stored !== null) return stored === 'true'
    return true // desktop defaults to open
  })
  const toggleFilter = useCallback(() => {
    setFilterOpen(v => {
      const next = !v
      localStorage.setItem('gooners-filter-open', String(next))
      return next
    })
  }, [])
  const handleBestDealsToggle = useCallback(() => {
    setBestDeals(v => {
      const next = !v
      syncUrlParam('bestDeals', next)
      return next
    })
  }, [])

  // Favorites and the ignore bin are opposite views of the same "Show" segmented
  // control — only one can be active at a time, and 'all' clears both.
  const decisionView = showIgnoredOnly ? 'ignored' : showFavoritesOnly ? 'favorites' : 'all'
  const setDecisionView = useCallback((view) => {
    setShowFavoritesOnly(view === 'favorites')
    setShowIgnoredOnly(view === 'ignored')
  }, [])

  // ✨ AI enrichment presence filter — toggled from the sidebar "Has" section.
  const handleEnrichmentFilterChange = useCallback((checked) => {
    captureEvent('enriched_filter_toggled', { active: checked })
    setShowEnrichedOnly(checked)
  }, [])

  // Deep-link: open item modal once data loads
  const initialItemKey = useRef(readParam(URL_PARAMS.item))
  const itemDeepLinked = useRef(false)
  useEffect(() => {
    if (!initialItemKey.current || itemDeepLinked.current) return
    // Wait for at least the first page; with progressive render the target lot
    // may only arrive in a later page, so keep retrying as `items` grows and
    // only give up (latch) once the full set is in.
    if (loading && !loadComplete) return
    const key = initialItemKey.current
    const colonIdx = key.indexOf(':')
    if (colonIdx < 0) { itemDeepLinked.current = true; return }
    const safeId = key.slice(0, colonIdx)
    const itemId = key.slice(colonIdx + 1)
    const found = items.find(i => i.auctionSafeId === safeId && String(i.id) === itemId)
    if (found) {
      setSelectedKey(itemKey(found))
      itemDeepLinked.current = true
      return
    }
    if (!loadComplete) return
    // Not in the active set. The lot may be archived — or a live-auction lot
    // that closed early and is now hidden from the active grid (per-lot expiry).
    // Pull in the archive so the shared link still resolves, then retry as the
    // larger set loads; only give up once the archive has finished loading too.
    if (archiveMode === 'active') {
      changeArchiveMode('both')
      return
    }
    if (!archiveLoading) itemDeepLinked.current = true
  }, [loading, loadComplete, items, archiveMode, archiveLoading, changeArchiveMode])

  const handleItemClick = useCallback((item) => {
    const key = itemKey(item)
    // Push (not replace) a history entry so browser Back — and Android's system
    // back gesture — dismiss the panel instead of leaving the site.
    pushUrlParam(URL_PARAMS.item, key, ITEM_PANEL_STATE)
    setSelectedKey(key)
    captureEvent('item_opened', {
      category: item.category ?? null,
      auction: item.auctionSafeId ?? null,
    })
  }, [])

  const handleItemClose = useCallback(() => {
    // If we pushed an entry for this panel, pop it (so URL + history both
    // unwind and the popstate handler clears the selection); a deep-linked open
    // has no pushed entry, so just strip the param in place.
    if (window.history.state?.goonersItemPanel) {
      window.history.back()
    } else {
      syncUrlParam(URL_PARAMS.item, null)
      setSelectedKey(null)
    }
  }, [])

  // Browser Back/Forward is the source of truth for the panel: re-derive the
  // selection from the `item` param whenever history moves.
  useEffect(() => {
    const onPop = () => setSelectedKey(readParam(URL_PARAMS.item) || null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Resale intelligence (eBay comps + Cannon's comps + sold history) is
  // members-only: RLS gates all of it to logged-in users (migrations 0008 +
  // 0009), so the hooks only fetch when signed in. `resaleLocked` is true only
  // when auth is available but no one is signed in — when Supabase is
  // unconfigured (offline static site, no login possible) it's false, so the
  // detail panel shows the resale cluster instead of the gate.
  const resaleLocked = auth.available && !auth.user

  const allComps = useEbayComps(auctionSafeIds, Boolean(auth.user))
  const allCannonsComps = useCannonsComps(auctionSafeIds, Boolean(auth.user))
  // Per-category Cannon's sold-price baseline (#95): feeds the "Best margin"
  // sort (#97) and the detail panel's category history (#96).
  const categorySoldStats = useCategorySoldStats(Boolean(auth.user))

  // Keep typing and slider-dragging at native speed: the heavy
  // locality→search→filter→sort pipeline consumes *deferred* copies of the
  // fast-changing inputs, so React 19 keeps the controls interactive and
  // recomputes the grid in a background render that the latest input can
  // interrupt. The filter chips and sliders still bind to the immediate values.
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const deferredMinPrice = useDeferredValue(minPrice)
  const deferredMaxPrice = useDeferredValue(maxPrice)
  const deferredMinBids = useDeferredValue(minBids)
  const deferredMaxBids = useDeferredValue(maxBids)
  const deferredMinBidders = useDeferredValue(minBidders)
  const deferredMaxBidders = useDeferredValue(maxBidders)
  const deferredMinHours = useDeferredValue(minHours)
  const deferredMaxHours = useDeferredValue(maxHours)

  // Items the user has signalled interest in — drives the For You sort.
  // favoriteIds in deps ensures the memo updates when favorites change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const favoriteItems = useMemo(() => items.filter(isFavorite), [items, favoriteIds])
  // Ignored items present in the currently-loaded set (active/archive scope).
  // ignoredIds in deps ensures the memo updates when the ignore list changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ignoredItems = useMemo(() => items.filter(isIgnored), [items, ignoredIds])
  const bidItems = useMemo(
    () => items.filter(i => cannonBids.bidItemIds.has(String(i.id))),
    [items, cannonBids.bidItemIds]
  )
  // Items from the user's permanently-excluded categories: used as a negative
  // signal in the For You ranking (their embeddings' centroid gets subtracted
  // from the taste vector, pushing results away from excluded category types).
  const baselineExcludedItems = useMemo(
    () => items.filter(item =>
      baselineExcludedGroups.includes(item.category) ||
      baselineExcludedCategories.includes(item.rawCategory)
    ),
    [items, baselineExcludedGroups, baselineExcludedCategories]
  )

  const hasForYouSignal = favoriteItems.length > 0 || bidItems.length > 0

  // Compute the taste ranking whenever the user has any signal — not just while
  // the For You sort is active — so the scores are already in hand when the
  // swipe deck opens (it snapshots a frozen order) and so switching to the For
  // You sort is instant rather than waiting on a fetch.
  const { scoreByKey: forYouScores } = useForYou(
    favoriteItems,
    bidItems,
    ignoredItems,
    baselineExcludedItems,
    auctions,
    hasForYouSignal,
  )

  // If the user's history disappears (logout / clears all favorites), fall back.
  useEffect(() => {
    if (sort === 'foryou' && !hasForYouSignal) setSort('')
  }, [sort, hasForYouSignal, setSort])

  // The whole locality → search → filter → sort chain lives in useItemPipeline
  // (extracted verbatim from here — see that hook for the per-stage comments).
  const {
    visibleAuctions,
    visibleItems,
    searchIds,
    semanticStatus,
    rangeFilterItems,
    groupedCategories,
    displayItems,
    finalItems,
    sortedItems,
    cannonBidCount,
  } = useItemPipeline({
    items,
    auctions,
    localOnly,
    userLat,
    userLng,
    maxDistanceMiles,
    searchQuery: deferredSearchQuery,
    excludedCategories,
    excludedGroups,
    minPrice: deferredMinPrice, maxPrice: deferredMaxPrice,
    minBids: deferredMinBids, maxBids: deferredMaxBids,
    minBidders: deferredMinBidders, maxBidders: deferredMaxBidders,
    minHours: deferredMinHours, maxHours: deferredMaxHours,
    hasComp,
    hasCannonsComp,
    bestDeals,
    showFavoritesOnly,
    showIgnoredOnly,
    showEnrichedOnly,
    sort,
    margin,
    isFavorite,
    isIgnored,
    allComps,
    allCannonsComps,
    categorySoldStats,
    bidItemIds: cannonBids.bidItemIds,
    forYouByKey: forYouScores,
  })

  // Search telemetry — debounced so it fires once the query settles, not on
  // every keystroke. We log the query *shape* (length, result count, whether
  // semantic search contributed), never the raw text, to keep it anonymous.
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) return
    const timer = setTimeout(() => {
      captureEvent('search_performed', {
        query_length: q.length,
        result_count: searchIds ? searchIds.size : 0,
        semantic: semanticStatus === 'ready',
      })
    }, 800)
    return () => clearTimeout(timer)
  }, [searchQuery, searchIds, semanticStatus])

  // Snapshot the not-yet-decided items when the swipe deck opens so the deck
  // doesn't reshuffle as the user favorites/ignores its way through. Rank that
  // snapshot by the user's "For You" taste score (when we have signal) so the
  // most-likely-to-love lots come up first; fall back to the current grid order
  // when there's no signal (or scores haven't loaded yet).
  const openSwipe = useCallback(() => {
    const deck = displayItems.filter(item => !isIgnored(item) && !isFavorite(item))
    const ranked = forYouScores.size > 0 ? sortByForYou(deck, forYouScores) : deck
    setSwipeItems(ranked)
    setSwipeOpen(true)
    captureEvent('swipe_deck_opened', { count: ranked.length, ranked: forYouScores.size > 0 })
  }, [displayItems, isIgnored, isFavorite, forYouScores])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (localOnly) n++
    if (archiveMode !== 'active') n++
    if (decisionView !== 'all') n++
    if (bestDeals) n++
    if (minPrice !== null || maxPrice !== null) n++
    if (minBids !== null || maxBids !== null) n++
    if (minBidders !== null || maxBidders !== null) n++
    if (minHours !== null || maxHours !== null) n++
    if (hasComp) n++
    if (hasCannonsComp) n++
    if (showEnrichedOnly) n++
    // Count category filters only when the session differs from the user's
    // baseline — baseline exclusions are permanent preferences, not transient filters.
    const baseGroups = new Set(baselineExcludedGroups)
    const baseCats = new Set(baselineExcludedCategories)
    const hasCategorySessionOverride =
      excludedGroups.some(g => !baseGroups.has(g)) ||
      baselineExcludedGroups.some(g => !excludedGroups.includes(g)) ||
      excludedCategories.some(c => !baseCats.has(c)) ||
      baselineExcludedCategories.some(c => !excludedCategories.includes(c))
    if (hasCategorySessionOverride) n++
    if (excludedAuctions.length > 0) n++
    if (searchQuery.trim()) n++
    return n
  }, [localOnly, archiveMode, decisionView, bestDeals, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours, hasComp, hasCannonsComp, showEnrichedOnly, excludedCategories, excludedGroups, baselineExcludedGroups, baselineExcludedCategories, excludedAuctions, searchQuery])

  const clearAllFilters = useCallback(() => {
    setLocalOnly(false)
    // Distance filter resets to the default 25 mi of Richmond, VA — the same
    // state as a fresh page load (not "Any distance").
    setUserLocation(DEFAULT_LOCATION)
    setMaxDistanceMiles(DEFAULT_RADIUS_MILES)
    changeArchiveMode('active')
    setDecisionView('all')
    setBestDeals(false)
    syncUrlParam('bestDeals', false)
    setMinPrice(null)
    setMaxPrice(null)
    setMinBids(null)
    setMaxBids(null)
    setMinBidders(null)
    setMaxBidders(null)
    setMinHours(null)
    setMaxHours(null)
    setHasComp(false)
    setHasCannonsComp(false)
    setShowEnrichedOnly(false)
    showAll()
    showAllAuctions()
    setSearchQuery('')
  }, [setLocalOnly, setUserLocation, setMaxDistanceMiles, changeArchiveMode, setDecisionView, setMinPrice, setMaxPrice, setMinBids, setMaxBids, setMinBidders, setMaxBidders, setMinHours, setMaxHours, setHasComp, setHasCannonsComp, setShowEnrichedOnly, showAll, showAllAuctions, setSearchQuery])

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app" style={{ '--header-height': `${isFinite(headerHeight) ? headerHeight : 0}px` }}>
      <header ref={headerRef} className={`app-header${headerVisible ? '' : ' header-hidden'}`}>
        <div className="header-row">
          <div className="header-banner">
            <button
              type="button"
              className="header-menu-button"
              onClick={() => setNavOpen(true)}
              aria-label={bidAlertCount > 0 ? `Menu (${bidAlertCount} bid update${bidAlertCount > 1 ? 's' : ''})` : 'Menu'}
              aria-expanded={navOpen}
              aria-haspopup="dialog"
            >
              <span className="header-menu-icon" aria-hidden="true">☰</span>
              {menuBadge.kind === 'count' && (
                <span className="header-menu-badge" aria-hidden="true">{menuBadge.value}</span>
              )}
              {menuBadge.kind === 'dot' && (
                <span className="header-menu-dot" aria-hidden="true" />
              )}
            </button>
            <button
              className="home-button"
              onClick={() => { window.location.href = '/' }}
              title="Go to home"
              aria-label="Home"
            >
              <img src="/arsenal-1930s.png" className="home-crest" alt="Arsenal FC Art Deco crest" />
            </button>

            <div className="header-title">
              <h1 className="logo">James River Gooners</h1>
              <span className="tagline">the best way to browse RVA auctions</span>
            </div>

            <AccountButton
              auth={auth}
              cannonBids={auth.user ? cannonBids : null}
              onSignInClick={() => setAuthOpen(true)}
              onCannonLinkClick={() => setCannonLinkOpen(true)}
              baselineExcludedGroups={baselineExcludedGroups}
              baselineExcludedCategories={baselineExcludedCategories}
              onRemoveBaselineGroup={removeBaselineGroup}
              onRemoveBaselineCategory={removeBaselineCategory}
              onClearBaseline={clearBaseline}
            />
          </div>

          <div className="header-search-wrap">
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              semanticStatus={semanticStatus}
            />
          </div>

          <div className="header-controls">
            <button
              type="button"
              className={`filter-toggle-btn${filterOpen ? ' filter-toggle-btn--open' : ''}`}
              onClick={toggleFilter}
              aria-expanded={filterOpen}
              aria-label="Toggle filters"
            >
              <span className="filter-toggle-icon" aria-hidden="true">⚙</span>
              <span className="filter-toggle-label">Filters</span>
              {activeFilterCount > 0 && (
                <span className="filter-count-badge">{activeFilterCount}</span>
              )}
            </button>

            <div className="layout-toggle" role="group" aria-label="Grid layout">
              {[
                { value: 'grid', label: '⊞', title: 'Grid view' },
                { value: 'compact', label: '≡', title: 'Compact view' },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={`layout-toggle-btn${viewMode === opt.value ? ' active' : ''}`}
                  aria-pressed={viewMode === opt.value}
                  title={opt.title}
                  onClick={() => setViewMode(opt.value)}
                >{opt.label}</button>
              ))}
            </div>

            <SortBar value={sort} onChange={setSort} showForYou={hasForYouSignal} />
          </div>

          <div className="header-actions">
            <button
              type="button"
              className="swipe-banner-button"
              onClick={() => setImageSearchOpen(true)}
              title="Search by photo"
              aria-label="Search by photo"
            >📷</button>
            <button
              type="button"
              className="swipe-banner-button"
              onClick={openSwipe}
              title="Review items one at a time"
            >⇄</button>
            <button
              className="help-button"
              onClick={openTutorial}
              title="How to use this site"
              aria-label="Open help"
            >?</button>
            <button
              className={`whatsnew-button${hasUnseen ? ' has-unseen' : ''}`}
              onClick={() => {
                captureEvent('whats_new_opened', { hasUnseen })
                openWhatsNew()
              }}
              title="What's new"
              aria-label={hasUnseen ? "What's new (updates available)" : "What's new"}
            >
              <span aria-hidden="true">✨</span>
            </button>
            <ArsenalTrivia />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <NavDrawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        onImageSearch={() => setImageSearchOpen(true)}
        onSwipe={openSwipe}
        onTutorial={openTutorial}
        onWhatsNew={() => { captureEvent('whats_new_opened', { hasUnseen }); openWhatsNew() }}
        whatsNewUnseen={hasUnseen}
        onFeedback={() => setFeedbackOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        auth={auth}
        cannonBids={auth.user ? cannonBids : null}
        onSignInClick={() => setAuthOpen(true)}
        onCannonLinkClick={() => setCannonLinkOpen(true)}
        baselineExcludedGroups={baselineExcludedGroups}
        baselineExcludedCategories={baselineExcludedCategories}
        onRemoveBaselineGroup={removeBaselineGroup}
        onRemoveBaselineCategory={removeBaselineCategory}
        onClearBaseline={clearBaseline}
      />

      <div className={`app-body${filterOpen ? '' : ' app-body--sidebar-closed'}`}>
        <FilterPanel
          open={filterOpen}
          onClose={() => setFilterOpen(false)}
          archiveMode={archiveMode}
          onArchiveModeChange={changeArchiveMode}
          decisionView={decisionView}
          onDecisionViewChange={setDecisionView}
          localOnly={localOnly}
          onLocalOnlyChange={setLocalOnly}
          userLocationLabel={userLocationLabel}
          maxDistanceMiles={maxDistanceMiles}
          onSetLocation={setUserLocation}
          onMaxDistanceChange={setMaxDistanceMiles}
          onMyBidsPanelOpen={() => setMyBidsPanelOpen(true)}
          bestDeals={bestDeals}
          onBestDealsToggle={handleBestDealsToggle}
          favoriteCount={favoriteItems.length}
          ignoredCount={ignoredItems.length}
          cannonBidsLinked={cannonBids.linked}
          cannonBidCount={cannonBidCount}
          cannonBidsLoading={cannonBids.bidsLoading}
          items={rangeFilterItems}
          bounds={filterBounds}
          minPrice={minPrice} maxPrice={maxPrice}
          onMinPriceChange={setMinPrice} onMaxPriceChange={setMaxPrice}
          minBids={minBids} maxBids={maxBids}
          onMinBidsChange={setMinBids} onMaxBidsChange={setMaxBids}
          minBidders={minBidders} maxBidders={maxBidders}
          onMinBiddersChange={setMinBidders} onMaxBiddersChange={setMaxBidders}
          minHours={minHours} maxHours={maxHours}
          onMinHoursChange={setMinHours} onMaxHoursChange={setMaxHours}
          hasEbayComp={hasComp}
          onHasEbayCompChange={setHasComp}
          hasCannonsComp={hasCannonsComp}
          onHasCannonsCompChange={setHasCannonsComp}
          hasEnrichment={showEnrichedOnly}
          onHasEnrichmentChange={handleEnrichmentFilterChange}
          auctions={visibleAuctions}
          excludedAuctions={excludedAuctions}
          onToggleAuction={toggleAuction}
          onShowAllAuctions={showAllAuctions}
          onShowOnlyAuction={showOnlyAuction}
          onHideSource={(src) => hideSource(src, visibleAuctions)}
          onShowSource={(src) => showSource(src, visibleAuctions)}
          archiveLoading={archiveLoading}
          archiveError={archiveError}
          groupedCategories={groupedCategories}
          excludedCategories={excludedCategories}
          excludedGroups={excludedGroups}
          baselineExcludedGroups={baselineExcludedGroups}
          baselineExcludedCategories={baselineExcludedCategories}
          onToggleExcluded={toggleExcluded}
          onHideGroup={hideGroup}
          onShowGroup={showGroup}
          onHideAll={() => hideAll(groupedCategories.map(g => g.group))}
          onShowAll={showAll}
          onShowOnly={showOnly}
          onAddBaselineGroup={addBaselineGroup}
          onRemoveBaselineGroup={removeBaselineGroup}
          onAddBaselineCategory={addBaselineCategory}
          onRemoveBaselineCategory={removeBaselineCategory}
        />

        <main data-load-complete={loadComplete ? 'true' : 'false'}>
          <ActiveFilters
            searchQuery={searchQuery}
            onClearSearch={() => setSearchQuery('')}
            localOnly={localOnly}
            onClearLocal={() => setLocalOnly(false)}
            maxDistanceMiles={maxDistanceMiles}
            userLocationLabel={userLocationLabel}
            onClearDistance={() => setMaxDistanceMiles(null)}
            archiveMode={archiveMode}
            onClearArchive={() => changeArchiveMode('active')}
            decisionView={decisionView}
            onClearDecision={() => setDecisionView('all')}
            bestDeals={bestDeals}
            onClearBestDeals={() => { setBestDeals(false); syncUrlParam('bestDeals', false) }}
            minPrice={minPrice} maxPrice={maxPrice}
            onClearPrice={() => { setMinPrice(null); setMaxPrice(null) }}
            minBids={minBids} maxBids={maxBids}
            onClearBids={() => { setMinBids(null); setMaxBids(null) }}
            minBidders={minBidders} maxBidders={maxBidders}
            onClearBidders={() => { setMinBidders(null); setMaxBidders(null) }}
            minHours={minHours} maxHours={maxHours}
            onClearHours={() => { setMinHours(null); setMaxHours(null) }}
            hasComp={hasComp}
            onClearComp={() => setHasComp(false)}
            hasCannonsComp={hasCannonsComp}
            onClearCannonsComp={() => setHasCannonsComp(false)}
            hasEnrichment={showEnrichedOnly}
            onClearEnrichment={() => setShowEnrichedOnly(false)}
            excludedCategoryCount={excludedCategories.length + excludedGroups.length}
            onClearCategories={showAll}
            excludedAuctionCount={excludedAuctions.length}
            onClearAuctions={showAllAuctions}
            onClearAll={clearAllFilters}
          />
          {loading ? (
            <div className="loading">
              <div className="fetch-loader">
                <div className="fetch-spinner" />
                <span className="fetch-label">
                  Fetching auction data<span className="fetch-dots"><span>.</span><span>.</span><span>.</span></span>
                </span>
              </div>
            </div>
          ) : bestDeals && finalItems.length === 0 ? (
            <div className="no-deals-message">
              <div className="item-count">0 items</div>
              <p>No best deals found.</p>
              <p className="no-deals-hint">
                Deal detection requires eBay sold-comp data. Most current auction items
                haven&apos;t been priced yet — try again after the next scraper run, or
                enable <strong>Archived auctions</strong> to see deals from past sales.
              </p>
            </div>
          ) : showFavoritesOnly && finalItems.length === 0 ? (
            <div className="no-deals-message">
              <div className="item-count">0 items</div>
              <p>No favorites yet.</p>
              <p className="no-deals-hint">
                Star items in the grid to save them here.
              </p>
            </div>
          ) : showIgnoredOnly && finalItems.length === 0 ? (
            <div className="no-deals-message">
              <div className="item-count">0 items</div>
              <p>Nothing ignored.</p>
              <p className="no-deals-hint">
                Hit the ✕ on an item to hide it from the grid. Ignored items show up here.
              </p>
            </div>
          ) : showEnrichedOnly && finalItems.length === 0 ? (
            <div className="no-deals-message">
              <div className="item-count">0 items</div>
              <p>No identified lots here yet.</p>
              <p className="no-deals-hint">
                Identification (brand &amp; model) is added by the enrichment step
                after a scrape. None of the lots in this view have a confident
                match yet — try clearing other filters or check back after the
                next run.
              </p>
            </div>
          ) : (
            <ItemGrid
              items={sortedItems}
              compact={viewMode === 'compact'}
              allComps={allComps}
              isFavorite={isFavorite}
              onToggleFavorite={handleToggleFavorite}
              isIgnored={isIgnored}
              onToggleIgnored={handleToggleIgnored}
              onItemClick={handleItemClick}
              bidStatuses={cannonBids.bidStatuses}
            />
          )}
        </main>
      </div>

      <Suspense fallback={null}>
      {tutorialOpen && <TutorialModal onClose={closeTutorial} />}

      {whatsNewOpen && <WhatsNewModal onClose={closeWhatsNew} seenIds={seenIds} />}

      {authOpen && <AuthModal auth={auth} onClose={() => setAuthOpen(false)} />}

      {cannonLinkOpen && auth.user && (
        <CannonLinkModal cannonBids={cannonBids} onClose={() => setCannonLinkOpen(false)} />
      )}

      {myBidsPanelOpen && auth.user && (
        <MyBidsPanel cannonBids={cannonBids} onClose={() => setMyBidsPanelOpen(false)} />
      )}

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          ebayComps={allComps[selectedItem.auctionSafeId] || {}}
          cannonsComps={allCannonsComps[selectedItem.auctionSafeId] || {}}
          categoryStats={categorySoldStats[selectedItem.category]}
          margin={margin}
          locked={resaleLocked}
          onSignInClick={() => setAuthOpen(true)}
          cannonBids={cannonBids}
          bidStatus={cannonBids.bidStatuses.get(String(selectedItem.id))}
          user={auth.user}
          onCannonLinkClick={() => setCannonLinkOpen(true)}
          isFavorite={isFavorite(selectedItem)}
          onToggleFavorite={handleToggleFavorite}
          isIgnored={isIgnored(selectedItem)}
          onToggleIgnored={handleToggleIgnored}
          onClose={handleItemClose}
        />
      )}

      {imageSearchOpen && (
        <ImageSearchModal
          onClose={() => setImageSearchOpen(false)}
          items={visibleItems}
          user={auth.user}
          onSearchInGrid={(terms) => {
            setSearchQuery(terms)
            setImageSearchOpen(false)
          }}
          onSignInClick={() => {
            setImageSearchOpen(false)
            setAuthOpen(true)
          }}
        />
      )}

      {swipeOpen && (
        <SwipeDeck
          items={swipeItems}
          onFavorite={handleToggleFavorite}
          onIgnore={handleToggleIgnored}
          onClose={() => setSwipeOpen(false)}
        />
      )}

      {feedbackOpen && (
        <FeedbackModal
          onClose={() => setFeedbackOpen(false)}
          user={auth.user}
        />
      )}

      </Suspense>
    </div>
  )
}