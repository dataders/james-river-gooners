import { useState, useMemo } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { useEbayComps } from './hooks/useEbayComps'
import { useFavorites } from './hooks/useFavorites'
import { usePreferences } from './hooks/usePreferences'
import { useTheme } from './hooks/useTheme'
import { filterItems, getGroupedCategories } from './utils/filters'
import { isDeal } from './utils/roiCalc'
import { DealsPanel } from './components/DealsPanel'
import { ArsenalTrivia } from './components/ArsenalTrivia'
import { AuctionFilter } from './components/AuctionFilter'
import { SearchBar } from './components/SearchBar'
import { RangeFilters } from './components/RangeFilters'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'
import { ThemeToggle } from './components/ThemeToggle'
import { ItemDetail } from './components/ItemDetail'

export default function App() {
  const [showArchived, setShowArchived] = useState(false)
  const {
    auctions,
    excludedAuctions,
    toggleAuction,
    items,
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
    toggleExcluded,
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
  } = usePreferences()

  const { theme, toggle: toggleTheme } = useTheme()
  const { isFavorite, toggleFavorite } = useFavorites()

  const [selectedItem, setSelectedItem] = useState(null)
  const [bestDeals, setBestDeals] = useState(false)
  const [showDeals, setShowDeals] = useState(false)

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

  // Items passing price/time/bids/search but NOT category filters — for dynamic counts
  const preFilteredItems = useMemo(
    () => filterItems(visibleItems, { excludedCategories: [], searchQuery, minPrice, maxPrice, minBids, maxBids, minHours, maxHours }),
    [visibleItems, searchQuery, minPrice, maxPrice, minBids, maxBids, minHours, maxHours]
  )

  const groupedCategories = useMemo(() => getGroupedCategories(preFilteredItems), [preFilteredItems])

  const filteredItems = useMemo(
    () => preFilteredItems.filter(item => !excludedCategories.includes(item.rawCategory)),
    [preFilteredItems, excludedCategories]
  )

  const displayItems = useMemo(() => {
    if (!bestDeals) return filteredItems
    return filteredItems.filter(item =>
      isDeal(item.currentBid, allComps[item.auctionSafeId]?.[item.id])
    )
  }, [filteredItems, bestDeals, allComps])

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-banner">
          <img src="/apple-touch-icon.png" className="banner-icon" alt="" aria-hidden="true" />
          <div className="banner-text">
            <h1 className="logo">James River Gooners</h1>
            <p className="tagline">A better way to browse Cannon's Auctions</p>
          </div>
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
              onChange={e => setShowArchived(e.target.checked)}
            />
            <span>Archived auctions</span>
          </label>
          <button
            type="button"
            className={`deals-toggle${bestDeals ? ' active' : ''}`}
            onClick={() => setBestDeals(v => !v)}
          >
            Best deals only
          </button>
          <button
            type="button"
            className={`deals-toggle${showDeals ? ' active' : ''}`}
            onClick={() => setShowDeals(v => !v)}
          >
            Deals view
          </button>
        </div>
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
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
        />
      </header>

      <main>
        {loading ? (
          <div className="loading">Loading auction items...</div>
        ) : showDeals ? (
          <DealsPanel items={visibleItems} allComps={allComps} />
        ) : bestDeals && displayItems.length === 0 ? (
          <div className="no-deals-message">
            <div className="item-count">0 items</div>
            <p>No best deals found.</p>
            <p className="no-deals-hint">
              Deal detection requires eBay sold-comp data. Most current auction items
              haven&apos;t been priced yet — try again after the next scraper run, or
              enable <strong>Archived auctions</strong> to see deals from past sales.
            </p>
          </div>
        ) : (
          <ItemGrid
            items={displayItems}
            allComps={allComps}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
            onItemClick={setSelectedItem}
          />
        )}
      </main>

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          ebayComps={allComps[selectedItem.auctionSafeId] || {}}
          isFavorite={isFavorite(selectedItem)}
          onToggleFavorite={toggleFavorite}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  )
}
