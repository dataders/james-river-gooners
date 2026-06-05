import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { useEbayComps } from './hooks/useEbayComps'
import { useFavorites } from './hooks/useFavorites'
import { useAuth } from './hooks/useAuth'
import { useCannonBids } from './hooks/useCannonBids'
import { usePreferences } from './hooks/usePreferences'
import { useTheme } from './hooks/useTheme'
import { useHeaderVisible } from './hooks/useHeaderVisible'
import { filterItems, getGroupedCategories } from './utils/filters'
import { useSearch } from './hooks/useSearch'
import { useSemanticSearch } from './hooks/useSemanticSearch'
import { isDeal } from './utils/roiCalc'
import { itemKey } from './utils/itemKey'
import { hasEbayComps } from './utils/ebayComps'
import { sortItems } from './utils/sort'
import { syncUrlParam } from './utils/urlState'
import { captureEvent } from './lib/analytics'
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { SortBar } from './components/SortBar'
import { AuctionFilter } from './components/AuctionFilter'
import { SearchBar } from './components/SearchBar'
import { RangeFilters } from './components/RangeFilters'
import { MarginPreference } from './components/MarginPreference'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'
import { TutorialModal } from './components/TutorialModal'
import { AuthModal } from './components/AuthModal'
import { CannonLinkModal } from './components/CannonLinkModal'
import { AccountButton } from './components/AccountButton'
import { useTutorial } from './hooks/useTutorial'

export default function App() {
  const [showArchived, setShowArchived] = useState(
    () => new URLSearchParams(window.location.search).get('archive') === '1'
  )
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
  } = useAuctionData(showArchived)

  const {
    excludedCategories,
    searchQuery,
    minPrice,
    maxPrice,
    minBids,
    maxBids,
    minHours,
    maxHours,
    localOnly,
    hasComp,
    sort,
    margin,
    toggleExcluded,
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
    setMargin,
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { tutorialOpen, openTutorial, closeTutorial } = useTutorial()
  const auth = useAuth()
  const [authOpen, setAuthOpen] = useState(false)
  const [cannonLinkOpen, setCannonLinkOpen] = useState(false)
  const { favoriteIds, isFavorite, toggleFavorite } = useFavorites(auth.user)
  const cannonBids = useCannonBids(auth.user)

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
  const [showMyBidsOnly, setShowMyBidsOnly] = useState(false)

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

  const auctionSafeIds = useMemo(() => auctions.map(a => a.safeId), [auctions])
  const allComps = useEbayComps(auctionSafeIds)

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
    () => filterItems(visibleItems, { excludedCategories: [], searchIds, minPrice, maxPrice, minBids, maxBids, minHours, maxHours }),
    [visibleItems, searchIds, minPrice, maxPrice, minBids, maxBids, minHours, maxHours]
  )

  const groupedCategories = useMemo(() => getGroupedCategories(preFilteredItems), [preFilteredItems])

  const filteredItems = useMemo(
    () => preFilteredItems.filter(item => !excludedCategories.includes(item.rawCategory)),
    [preFilteredItems, excludedCategories]
  )

  const displayItems = useMemo(() => {
    let result = filteredItems
    if (hasComp) {
      result = result.filter(item =>
        hasEbayComps(allComps[item.auctionSafeId]?.[item.id])
      )
    }
    if (bestDeals) {
      result = result.filter(item =>
        isDeal(item.currentBid, allComps[item.auctionSafeId]?.[item.id])
      )
    }
    return result
  }, [filteredItems, hasComp, bestDeals, allComps])

  const finalItems = useMemo(() => {
    let result = displayItems
    if (showFavoritesOnly) result = result.filter(isFavorite)
    if (showMyBidsOnly) result = result.filter(item => cannonBids.bidItemIds.has(String(item.id)))
    return result
  }, [displayItems, showFavoritesOnly, isFavorite, showMyBidsOnly, cannonBids.bidItemIds])

  const sortedItems = useMemo(() => sortItems(finalItems, sort), [finalItems, sort])

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
          <label className="local-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => {
              syncUrlParam('archive', e.target.checked)
              setShowArchived(e.target.checked)
              captureEvent('archive_toggled', { enabled: e.target.checked })
            }}
            />
            <span>Archived auctions</span>
          </label>
          <button
            type="button"
            className={`deals-toggle${showFavoritesOnly ? ' active' : ''}`}
            onClick={() => setShowFavoritesOnly(v => !v)}
          >
            {favoriteIds.length > 0 ? `Favorites (${favoriteIds.length})` : 'Favorites'}
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
            Has comp
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
            minHours={minHours}
            maxHours={maxHours}
            onMinPriceChange={v => setMinPrice(v)}
            onMaxPriceChange={v => setMaxPrice(v)}
            onMinBidsChange={v => setMinBids(v)}
            onMaxBidsChange={v => setMaxBids(v)}
            onMinHoursChange={v => setMinHours(v)}
            onMaxHoursChange={v => setMaxHours(v)}
          />
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
            onToggleExcluded={toggleExcluded}
            onHideAll={() => {
              const allRaw = groupedCategories.flatMap(g => g.rawCategories.map(c => c.name))
              hideAll(allRaw)
            }}
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
              onToggleFavorite={toggleFavorite}
              onItemClick={handleItemClick}
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
          margin={margin}
          isFavorite={isFavorite(selectedItem)}
          onToggleFavorite={toggleFavorite}
          onClose={handleItemClose}
        />
      )}
    </div>
  )
}
