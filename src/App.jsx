import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
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
import { useTheme } from './hooks/useTheme'
import { useHeaderVisible } from './hooks/useHeaderVisible'
import { filterItems, getGroupedCategories } from './utils/filters'
import { useSearch } from './hooks/useSearch'
import { useSemanticSearch } from './hooks/useSemanticSearch'
import { isDeal } from './utils/roiCalc'
import { marginForItem, maxBidForItem } from './utils/soldHistory'
import { itemKey } from './utils/itemKey'
import { hasEbayComps } from './utils/ebayComps'
import { hasCannonsComps } from './utils/cannonsComps'
import { hasEnrichment, overlayEnrichment } from './utils/enrichment'
import { sortItems, sortByMargin, sortByMaxBid } from './utils/sort'
import { syncUrlParam } from './utils/urlState'
import { captureEvent } from './lib/telemetry'
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { SortBar } from './components/SortBar'
import { SearchBar } from './components/SearchBar'
import { FilterPanel } from './components/FilterPanel'
import { ActiveFilters } from './components/ActiveFilters'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'
import { SwipeDeck } from './components/SwipeDeck'
import { TutorialModal } from './components/TutorialModal'
import { WhatsNewModal } from './components/WhatsNewModal'
import { AuthModal } from './components/AuthModal'
import { CannonLinkModal } from './components/CannonLinkModal'
import { MyBidsPanel } from './components/MyBidsPanel'
import { ImageSearchModal } from './components/ImageSearchModal'
import { AccountButton } from './components/AccountButton'
import { useTutorial } from './hooks/useTutorial'
import { useWhatsNew } from './hooks/useWhatsNew'

export default function App() {
  // 'active' (live auctions only), 'both' (live + archived), or 'archived'
  // (past auctions only). 'archive=1' is the legacy URL value for 'both'.
  const [archiveMode, setArchiveMode] = useState(() => {
    const v = new URLSearchParams(window.location.search).get('archive')
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

  const changeArchiveMode = useCallback((mode) => {
    setArchiveMode(mode)
    syncUrlParam('archive', mode === 'active' ? '' : mode)
    captureEvent('archive_mode_changed', { mode })
  }, [])

  const {
    excludedCategories,
    excludedGroups,
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
    setHasComp,
    setHasCannonsComp,
    setSort,
    setViewMode,
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { tutorialOpen, openTutorial, closeTutorial } = useTutorial()
  const { whatsNewOpen, hasUnseen, seenIds, openWhatsNew, closeWhatsNew } = useWhatsNew()
  const auth = useAuth()
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

  const [selectedItem, setSelectedItem] = useState(null)
  const [bestDeals, setBestDeals] = useState(
    () => new URLSearchParams(window.location.search).get('bestDeals') === '1'
  )
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
  const [showIgnoredOnly, setShowIgnoredOnly] = useState(false)
  const [myBidsPanelOpen, setMyBidsPanelOpen] = useState(false)
  const [showEnrichedOnly, setShowEnrichedOnly] = useState(false)
  const [swipeOpen, setSwipeOpen] = useState(false)
  const [swipeItems, setSwipeItems] = useState([])
  const [imageSearchOpen, setImageSearchOpen] = useState(false)
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
  const initialItemKey = useRef(new URLSearchParams(window.location.search).get('item'))
  const itemDeepLinked = useRef(false)
  useEffect(() => {
    if (!initialItemKey.current || loading || itemDeepLinked.current) return
    itemDeepLinked.current = true
    const key = initialItemKey.current
    const colonIdx = key.indexOf(':')
    if (colonIdx < 0) return
    const safeId = key.slice(0, colonIdx)
    const itemId = key.slice(colonIdx + 1)
    const found = items.find(i => i.auctionSafeId === safeId && String(i.id) === itemId)
    if (found) setSelectedItem(found)
  }, [loading, items])

  const handleItemClick = useCallback((item) => {
    syncUrlParam('item', itemKey(item))
    setSelectedItem(item)
    captureEvent('item_opened', {
      category: item.category ?? null,
      auction: item.auctionSafeId ?? null,
    })
  }, [])

  const handleItemClose = useCallback(() => {
    syncUrlParam('item', null)
    setSelectedItem(null)
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

  const localAuctionIds = useMemo(() => {
    const ids = new Set()
    for (const a of auctions) {
      if (a.isLocal) ids.add(a.safeId)
    }
    return ids
  }, [auctions])

  // Apply locality filter upstream so auctions list + category counts reflect it
  const visibleAuctions = useMemo(
    () => localOnly ? auctions.filter(a => a.isLocal) : auctions,
    [auctions, localOnly]
  )

  const visibleItems = useMemo(
    () => localOnly ? items.filter(item => localAuctionIds.has(item.auctionSafeId)) : items,
    [items, localOnly, localAuctionIds]
  )

  const searchIndex = useSearch(visibleItems)
  const miniSearchIds = useMemo(() => {
    if (!searchQuery) return null
    return new Set(searchIndex.search(searchQuery).map(r => r.id))
  }, [searchIndex, searchQuery])

  const { semanticIds, semanticStatus } = useSemanticSearch(searchQuery)

  // Hybrid blend: intersect when both are available so semantic filters keyword false positives.
  // If keyword finds nothing (semantic-only query like "vintage mid-century"), use semantic alone.
  // Falls back to keyword-only while the model is still loading.
  const searchIds = useMemo(() => {
    if (!searchQuery) return null
    if (!semanticIds) return miniSearchIds
    if (miniSearchIds.size === 0) return semanticIds
    return new Set([...miniSearchIds].filter(id => semanticIds.has(id)))
  }, [searchQuery, miniSearchIds, semanticIds])

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

  // Items for range-slider histograms: search + category filtered but no range filters,
  // so slider min/max/distribution dynamically reflects the current search/category context
  // without a circular dependency between the sliders themselves.
  const rangeFilterItems = useMemo(
    () => filterItems(visibleItems, { excludedCategories, excludedGroups, searchIds }),
    [visibleItems, excludedCategories, excludedGroups, searchIds]
  )

  // Items passing price/time/bids/search but NOT category filters — for dynamic counts
  const preFilteredItems = useMemo(
    () => filterItems(visibleItems, { excludedCategories: [], searchIds, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours }),
    [visibleItems, searchIds, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours]
  )

  const groupedCategories = useMemo(() => getGroupedCategories(preFilteredItems), [preFilteredItems])

  const filteredItems = useMemo(
    () => preFilteredItems.filter(item =>
      !excludedGroups.includes(item.category) &&
      !excludedCategories.includes(item.rawCategory)
    ),
    [preFilteredItems, excludedCategories, excludedGroups]
  )

  const displayItems = useMemo(() => {
    let result = filteredItems
    if (hasComp) {
      result = result.filter(item =>
        hasEbayComps(allComps[item.auctionSafeId]?.[item.id])
      )
    }
    if (hasCannonsComp) {
      result = result.filter(item =>
        hasCannonsComps(allCannonsComps[item.auctionSafeId]?.[item.id])
      )
    }
    if (bestDeals) {
      result = result.filter(item =>
        isDeal(item.currentBid, allComps[item.auctionSafeId]?.[item.id])
      )
    }
    return result
  }, [filteredItems, hasComp, hasCannonsComp, bestDeals, allComps, allCannonsComps])

  // Base filter: applies ignored/enriched filters but NOT favorites. Kept
  // separate so a favorite toggle doesn't invalidate this memo (which would
  // produce a new array reference, reset ItemGrid's loaded count, and jump
  // the scroll position back to the top).
  const decisionFilteredItems = useMemo(() => {
    if (showIgnoredOnly) return displayItems.filter(isIgnored)
    let result = displayItems.filter(item => !isIgnored(item))
    if (showEnrichedOnly) result = result.filter(hasEnrichment)
    return result
  }, [displayItems, showIgnoredOnly, isIgnored, showEnrichedOnly])

  // Apply favorites filter only when active. When inactive, return the stable
  // decisionFilteredItems reference so downstream memos don't recalculate and
  // ItemGrid's scroll position is preserved across favorite toggles.
  const finalItems = useMemo(() => {
    if (showFavoritesOnly) return decisionFilteredItems.filter(isFavorite)
    return decisionFilteredItems
  }, [decisionFilteredItems, showFavoritesOnly, isFavorite])

  // Count bids against loaded listings only — don't count seeded bids for
  // auctions not in the read model. Computed from filteredItems (respects
  // auction/search/price/category filters but not the My Bids toggle itself).
  const cannonBidCount = useMemo(
    () => filteredItems.filter(item => cannonBids.bidItemIds.has(String(item.id))).length,
    [filteredItems, cannonBids.bidItemIds],
  )

  // Snapshot the not-yet-decided items when the swipe deck opens so the deck
  // doesn't reshuffle as the user favorites/ignores its way through.
  const openSwipe = useCallback(() => {
    const deck = displayItems.filter(item => !isIgnored(item) && !isFavorite(item))
    setSwipeItems(deck)
    setSwipeOpen(true)
    captureEvent('swipe_deck_opened', { count: deck.length })
  }, [displayItems, isIgnored, isFavorite])

  // Estimated profit per item ($) for the "Best margin" sort (#97): eBay comp
  // median when present, else the Cannon's category median sold (#95). Only
  // computed when that sort is active.
  const marginByKey = useMemo(() => {
    const map = new Map()
    if (sort !== 'margin') return map
    for (const item of finalItems) {
      const m = marginForItem(
        item.currentBid,
        allComps[item.auctionSafeId]?.[item.id],
        categorySoldStats[item.category]
      )
      map.set(itemKey(item), m ? m.profit : null)
    }
    return map
  }, [sort, finalItems, allComps, categorySoldStats])

  // Recommended max bid per item ($) for the "Max bid" sort: resale estimate
  // (eBay comp median, else Cannon's category median) backed out through the
  // default resale margin + fees. Only computed when that sort is active.
  const maxBidByKey = useMemo(() => {
    const map = new Map()
    if (sort !== 'maxbid') return map
    for (const item of finalItems) {
      map.set(itemKey(item), maxBidForItem(
        allComps[item.auctionSafeId]?.[item.id],
        categorySoldStats[item.category],
        margin / 100
      ))
    }
    return map
  }, [sort, finalItems, allComps, categorySoldStats, margin])

  const sortedItems = useMemo(() => {
    if (sort === 'margin') return sortByMargin(finalItems, marginByKey)
    if (sort === 'maxbid') return sortByMaxBid(finalItems, maxBidByKey)
    return sortItems(finalItems, sort)
  }, [finalItems, sort, marginByKey, maxBidByKey])

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
    if (excludedCategories.length > 0 || excludedGroups.length > 0) n++
    if (excludedAuctions.length > 0) n++
    if (searchQuery.trim()) n++
    return n
  }, [localOnly, archiveMode, decisionView, bestDeals, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours, hasComp, hasCannonsComp, showEnrichedOnly, excludedCategories, excludedGroups, excludedAuctions, searchQuery])

  const clearAllFilters = useCallback(() => {
    setLocalOnly(false)
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
  }, [setLocalOnly, changeArchiveMode, setDecisionView, setMinPrice, setMaxPrice, setMinBids, setMaxBids, setMinBidders, setMaxBidders, setMinHours, setMaxHours, setHasComp, setHasCannonsComp, setShowEnrichedOnly, showAll, showAllAuctions, setSearchQuery])

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app" style={{ '--header-height': `${isFinite(headerHeight) ? headerHeight : 0}px` }}>
      <header ref={headerRef} className={`app-header${headerVisible ? '' : ' header-hidden'}`}>
        <div className="header-row">
          <div className="header-banner">
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

            <SortBar value={sort} onChange={setSort} />
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
          onMyBidsPanelOpen={() => setMyBidsPanelOpen(true)}
          bestDeals={bestDeals}
          onBestDealsToggle={handleBestDealsToggle}
          favoriteCount={favoriteIds.length}
          ignoredCount={ignoredIds.length}
          cannonBidsLinked={cannonBids.linked}
          cannonBidCount={cannonBidCount}
          cannonBidsLoading={cannonBids.bidsLoading}
          items={rangeFilterItems}
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
          onToggleExcluded={toggleExcluded}
          onHideGroup={hideGroup}
          onShowGroup={showGroup}
          onHideAll={() => hideAll(groupedCategories.map(g => g.group))}
          onShowAll={showAll}
          onShowOnly={showOnly}
        />

        <main>
          <ActiveFilters
            searchQuery={searchQuery}
            onClearSearch={() => setSearchQuery('')}
            localOnly={localOnly}
            onClearLocal={() => setLocalOnly(false)}
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
    </div>
  )
}
