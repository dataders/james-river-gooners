import { useState, useMemo } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { usePreferences } from './hooks/usePreferences'
import { filterItems, getGroupedCategories } from './utils/filters'
import { AuctionFilter } from './components/AuctionFilter'
import { SearchBar } from './components/SearchBar'
import { RangeFilters } from './components/RangeFilters'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'

export default function App() {
  const {
    auctions,
    excludedAuctions,
    toggleAuction,
    items,
    loading,
    error,
  } = useAuctionData()

  const {
    excludedCategories,
    searchQuery,
    toggleExcluded,
    hideAll,
    showAll,
    setSearchQuery,
  } = usePreferences()

  const [minPrice, setMinPrice] = useState(null)
  const [maxPrice, setMaxPrice] = useState(null)
  const [minBids, setMinBids] = useState(null)
  const [maxBids, setMaxBids] = useState(null)
  const [minHours, setMinHours] = useState(null)
  const [maxHours, setMaxHours] = useState(null)

  // Items passing price/time/bids/search but NOT category filters — for dynamic counts
  const preFilteredItems = useMemo(
    () => filterItems(items, { excludedCategories: [], searchQuery, minPrice, maxPrice, minBids, maxBids, minHours, maxHours }),
    [items, searchQuery, minPrice, maxPrice, minBids, maxBids, minHours, maxHours]
  )

  const groupedCategories = useMemo(() => getGroupedCategories(preFilteredItems), [preFilteredItems])

  const filteredItems = useMemo(
    () => preFilteredItems.filter(item => !excludedCategories.includes(item.rawCategory)),
    [preFilteredItems, excludedCategories]
  )

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1 className="logo">Gooners</h1>
        </div>
        <p className="tagline">A better way to browse Cannon's Auctions</p>
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
        <RangeFilters
          items={items}
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
          auctions={auctions}
          excludedAuctions={excludedAuctions}
          onToggle={toggleAuction}
        />
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
        ) : (
          <ItemGrid items={filteredItems} />
        )}
      </main>
    </div>
  )
}
