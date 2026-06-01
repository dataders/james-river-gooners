import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { useEbayComps } from './hooks/useEbayComps'
import { useFavorites } from './hooks/useFavorites'
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
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { SortBar } from './components/SortBar'
import { AuctionFilter } from './components/AuctionFilter'
import { SearchBar } from './components/SearchBar'
import { RangeFilters } from './components/RangeFilters'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'
import { TutorialModal } from './components/TutorialModal'
import { useTutorial } from './hooks/useTutorial'

export default function App() {
  const [showArchived, setShowArchived] = useState(
    () => new URLSearchParams(window.location.search).get('archive') === '1'
  )
  const {
    auctions,
    excludedAuctions,
    toggleAuction,
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
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { tutorialOpen, openTutorial, closeTutorial } = useTutorial()
  const { favoriteIds, isFavorite, toggleFavorite } = useFavorites()
  const headerVisible = useHeaderVisible()

  const [selectedItem, setSelectedItem] = useState(null)
  const [bestDeals, setBestDeals] = useState(
    () => new URLSearchParams(window.location.search).get('bestDeals') === '1'
  )
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)

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
    if (!showFavoritesOnly) return displayItems
    return displayItems.filter(isFavorite)
  }, [displayItems, showFavoritesOnly, isFavorite])

  const sortedItems = useMemo(() => sortItems(finalItems, sort), [finalItems, sort])

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app">
      <header className={`app-header${headerVisible ? '' : ' header-hidden'}`}>
        <div className="header-banner">
          <img src="/apple-touch-icon.png" className="banner-icon" alt="" aria-hidden="true" />
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
        <AuctionFilter
          auctions={visibleAuctions}
          excludedAuctions={excludedAuctions}
          onToggle={toggleAuction}
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
      </header>

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

      {tutorialOpen && <TutorialModal onClose={closeTutorial} />}

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          ebayComps={allComps[selectedItem.auctionSafeId] || {}}
          isFavorite={isFavorite(selectedItem)}
          onToggleFavorite={toggleFavorite}
          onClose={handleItemClose}
        />
      )}
    </div>
  )
}
