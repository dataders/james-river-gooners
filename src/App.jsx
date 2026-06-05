import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { useEbayComps } from './hooks/useEbayComps'
import { useCannonsComps } from './hooks/useCannonsComps'
import { useCategorySoldStats } from './hooks/useCategorySoldStats'
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
import { isDeal, meetsMinProfit } from './utils/roiCalc'
import { marginForItem } from './utils/soldHistory'
import { itemKey } from './utils/itemKey'
import { hasEbayComps } from './utils/ebayComps'
import { hasCannonsComps } from './utils/cannonsComps'
import { hasEnrichment } from './utils/enrichment'
import { sortItems, sortByMargin } from './utils/sort'
import { syncUrlParam } from './utils/urlState'
import { captureEvent } from './lib/telemetry'
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { SortBar } from './components/SortBar'
import { AuctionFilter } from './components/AuctionFilter'
import { SearchBar } from './components/SearchBar'
import { RangeFilters } from './components/RangeFilters'
import { MarginPreference } from './components/MarginPreference'
import { MinProfitFilter } from './components/MinProfitFilter'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'
import { SwipeDeck } from './components/SwipeDeck'
import { TutorialModal } from './components/TutorialModal'
import { AuthModal } from './components/AuthModal'
import { CannonLinkModal } from './components/CannonLinkModal'
import { AccountButton } from './components/AccountButton'
import { useTutorial } from './hooks/useTutorial'

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
    items,
    embeddingEntries,
    loading,
    error,
    archiveLoading,
    archiveError,
  } = useAuctionData(archiveMode)

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
    minProfit,
    localOnly,
    hasComp,
    hasCannonsComp,
    sort,
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
    setMinProfit,
    setLocalOnly,
    setHasComp,
    setHasCannonsComp,
    setSort,
    setMargin,
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { tutorialOpen, openTutorial, closeTutorial } = useTutorial()
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
  const [showMyBidsOnly, setShowMyBidsOnly] = useState(false)
  const [showEnrichedOnly, setShowEnrichedOnly] = useState(false)
  const [swipeOpen, setSwipeOpen] = useState(false)
  const [swipeItems, setSwipeItems] = useState([])

  // Favorites and the ignore bin are opposite views — turning one on closes the
  // other so the grid never tries to be both at once.
  const toggleFavoritesView = useCallback(() => {
    setShowFavoritesOnly(v => {
      if (!v) setShowIgnoredOnly(false)
      return !v
    })
  }, [])
  const toggleIgnoredView = useCallback(() => {
    setShowIgnoredOnly(v => {
      if (!v) setShowFavoritesOnly(false)
      return !v
    })
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

  // Resale intelligence (eBay comps + Cannon's sold history) is members-only:
  // RLS gates the Supabase data to logged-in users (migration 0008), and we hide
  // the static Cannon's comps to match. `resaleLocked` is true only when auth is
  // available but no one is signed in — when Supabase is unconfigured (offline
  // static site, no login possible) it's false, so those builds behave as before.
  const resaleLocked = auth.available && !auth.user

  const auctionSafeIds = useMemo(() => auctions.map(a => a.safeId), [auctions])
  const allComps = useEbayComps(auctionSafeIds, Boolean(auth.user))
  const allCannonsComps = useCannonsComps(auctionSafeIds, !resaleLocked)
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

  const { semanticIds, semanticStatus } = useSemanticSearch(searchQuery, embeddingEntries)

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
    if (minProfit != null) {
      result = result.filter(item =>
        meetsMinProfit(item.currentBid, allComps[item.auctionSafeId]?.[item.id], minProfit)
      )
    }
    return result
  }, [filteredItems, hasComp, hasCannonsComp, bestDeals, minProfit, allComps, allCannonsComps])

  const finalItems = useMemo(() => {
    // Ignored bin is its own exclusive view; otherwise ignored items are hidden
    // from the grid entirely (that's the point of marking "not interested").
    if (showIgnoredOnly) return displayItems.filter(isIgnored)
    let result = displayItems.filter(item => !isIgnored(item))
    if (showFavoritesOnly) result = result.filter(isFavorite)
    if (showMyBidsOnly) result = result.filter(item => cannonBids.bidItemIds.has(String(item.id)))
    if (showEnrichedOnly) result = result.filter(hasEnrichment)
    return result
  }, [displayItems, showIgnoredOnly, isIgnored, showFavoritesOnly, isFavorite, showMyBidsOnly, cannonBids.bidItemIds, showEnrichedOnly])

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

  const sortedItems = useMemo(
    () => sort === 'margin' ? sortByMargin(finalItems, marginByKey) : sortItems(finalItems, sort),
    [finalItems, sort, marginByKey]
  )

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app" style={{ '--header-height': `${isFinite(headerHeight) ? headerHeight : 0}px` }}>
      <header ref={headerRef} className={`app-header${headerVisible ? '' : ' header-hidden'}`}>
        <div className="header-banner">
          <button
            className="home-button"
            onClick={() => { window.location.href = '/' }}
            title="Go to home"
            aria-label="Home"
          >
            <img src="/arsenal-1930s.png" className="home-crest" alt="Arsenal FC Art Deco crest" />
          </button>
<div className="banner-text">
            <h1 className="logo">James River Gooners</h1>
            <p className="tagline">A better way to browse Cannon's Auctions</p>
          </div>
          <button
            className="help-button"
            onClick={openTutorial}
            title="How to use this site"
            aria-label="Open help"
          >?</button>
          <AccountButton
            auth={auth}
            cannonBids={auth.user ? cannonBids : null}
            onSignInClick={() => setAuthOpen(true)}
            onCannonLinkClick={() => setCannonLinkOpen(true)}
          />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
        <ArsenalTrivia />
        <div className="view-toggles">
          <label className="local-toggle">
            <input
              type="checkbox"
              checked={localOnly}
              onChange={e => setLocalOnly(e.target.checked)}
            />
            <span>Richmond area only</span>
          </label>
          <div className="archive-control">
            <span className="archive-label">Auctions</span>
            <div
              className="archive-segmented"
              role="group"
              aria-label="Which auctions to show"
            >
              {[
                { value: 'active', label: 'Active' },
                { value: 'archived', label: 'Archived' },
                { value: 'both', label: 'All' },
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  className={`segmented-option${archiveMode === opt.value ? ' active' : ''}`}
                  aria-pressed={archiveMode === opt.value}
                  onClick={() => changeArchiveMode(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`deals-toggle${showFavoritesOnly ? ' active' : ''}`}
            onClick={toggleFavoritesView}
          >
            {favoriteIds.length > 0 ? `Favorites (${favoriteIds.length})` : 'Favorites'}
          </button>
          <button
            type="button"
            className={`deals-toggle${showIgnoredOnly ? ' active' : ''}`}
            onClick={toggleIgnoredView}
          >
            {ignoredIds.length > 0 ? `Ignored (${ignoredIds.length})` : 'Ignored'}
          </button>
          <button
            type="button"
            className={`deals-toggle${showEnrichedOnly ? ' active' : ''}`}
            onClick={() => {
              setShowEnrichedOnly(v => {
                captureEvent('enriched_filter_toggled', { active: !v })
                return !v
              })
            }}
            title="Show only lots with an identified brand/model"
          >
            ✨ Identified
          </button>
          <button
            type="button"
            className="deals-toggle swipe-launch"
            onClick={openSwipe}
            title="Review items one at a time"
          >
            ⇄ Swipe
          </button>
          {cannonBids.linked && (
            <button
              type="button"
              className={`deals-toggle${showMyBidsOnly ? ' active' : ''}`}
              onClick={() => setShowMyBidsOnly(v => !v)}
              title={cannonBids.bidsLoading ? 'Fetching bids…' : `${cannonBids.bidItemIds.size} items bid on`}
            >
              {cannonBids.bidsLoading
                ? 'My Bids…'
                : cannonBids.bidItemIds.size > 0
                  ? `My Bids (${cannonBids.bidItemIds.size})`
                  : 'My Bids'}
            </button>
          )}
          <button
            type="button"
            className={`deals-toggle${bestDeals ? ' active' : ''}`}
            onClick={() => setBestDeals(v => {
              syncUrlParam('bestDeals', !v)
              return !v
            })}
          >
            Best deals
          </button>
          <button
            type="button"
            className={`deals-toggle${hasComp ? ' active' : ''}`}
            onClick={() => setHasComp(!hasComp)}
          >
            Has eBay comp
          </button>
          <button
            type="button"
            className={`deals-toggle${hasCannonsComp ? ' active' : ''}`}
            onClick={() => setHasCannonsComp(!hasCannonsComp)}
          >
            Has auction comp
          </button>
          <SortBar value={sort} onChange={setSort} />
        </div>
      </header>

      <div className="app-body">
        <aside className="filter-sidebar">
          <SearchBar value={searchQuery} onChange={setSearchQuery} semanticStatus={semanticStatus} />
          <RangeFilters
            items={visibleItems}
            minPrice={minPrice}
            maxPrice={maxPrice}
            minBids={minBids}
            maxBids={maxBids}
            minBidders={minBidders}
            maxBidders={maxBidders}
            minHours={minHours}
            maxHours={maxHours}
            onMinPriceChange={v => setMinPrice(v)}
            onMaxPriceChange={v => setMaxPrice(v)}
            onMinBidsChange={v => setMinBids(v)}
            onMaxBidsChange={v => setMaxBids(v)}
            onMinBiddersChange={v => setMinBidders(v)}
            onMaxBiddersChange={v => setMaxBidders(v)}
            onMinHoursChange={v => setMinHours(v)}
            onMaxHoursChange={v => setMaxHours(v)}
          />
          <MinProfitFilter value={minProfit} onChange={setMinProfit} />
          <MarginPreference value={margin} onChange={setMargin} />
          <AuctionFilter
            auctions={visibleAuctions}
            excludedAuctions={excludedAuctions}
            onToggle={toggleAuction}
            onShowAll={showAllAuctions}
            onShowOnly={showOnlyAuction}
            onHideSource={(src) => hideSource(src, visibleAuctions)}
            onShowSource={(src) => showSource(src, visibleAuctions)}
          />
          {archiveLoading && (
            <div className="inline-status">Loading archived auctions...</div>
          )}
          {archiveError && (
            <div className="inline-error">Archived auctions failed to load: {archiveError}</div>
          )}
          <FilterBar
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
        </aside>

        <main>
          {loading ? (
            <div className="loading">Loading auction items...</div>
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
          ) : showMyBidsOnly && finalItems.length === 0 ? (
            <div className="no-deals-message">
              <div className="item-count">0 items</div>
              <p>No bids found in current auctions.</p>
              <p className="no-deals-hint">
                {cannonBids.bidsLoading
                  ? 'Fetching your bid history from Cannon\'s…'
                  : 'Your Cannon\'s bid history didn\'t match any currently listed items. Try enabling archived auctions.'}
              </p>
            </div>
          ) : (
            <ItemGrid
              items={sortedItems}
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

      {authOpen && <AuthModal auth={auth} onClose={() => setAuthOpen(false)} />}

      {cannonLinkOpen && auth.user && (
        <CannonLinkModal cannonBids={cannonBids} onClose={() => setCannonLinkOpen(false)} />
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
          isFavorite={isFavorite(selectedItem)}
          onToggleFavorite={handleToggleFavorite}
          isIgnored={isIgnored(selectedItem)}
          onToggleIgnored={handleToggleIgnored}
          onClose={handleItemClose}
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
