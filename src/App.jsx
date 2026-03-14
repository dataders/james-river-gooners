import { useMemo } from 'react'
import { useAuctionData } from './hooks/useAuctionData'
import { usePreferences } from './hooks/usePreferences'
import { filterItems, getCategoryCounts } from './utils/filters'
import { AuctionPicker } from './components/AuctionPicker'
import { SearchBar } from './components/SearchBar'
import { FilterBar } from './components/FilterBar'
import { ItemGrid } from './components/ItemGrid'

function DataFreshness({ auctions, selectedId }) {
  const auction = auctions.find(a => a.safeId === selectedId)
  if (!auction?.scrapedAt) return null
  const scraped = new Date(auction.scrapedAt)
  const ago = Math.round((Date.now() - scraped) / 60000)
  const label = ago < 60
    ? `${ago}m ago`
    : ago < 1440
      ? `${Math.round(ago / 60)}h ago`
      : `${Math.round(ago / 1440)}d ago`
  return <span className="data-freshness">Data from {label}</span>
}

export default function App() {
  const {
    auctions,
    selectedAuctionId,
    setSelectedAuctionId,
    items,
    loading,
    error,
  } = useAuctionData()

  const {
    includedCategories,
    excludedCategories,
    searchQuery,
    toggleIncluded,
    toggleExcluded,
    clearIncluded,
    setSearchQuery,
  } = usePreferences()

  const categories = useMemo(() => getCategoryCounts(items), [items])

  const filteredItems = useMemo(
    () => filterItems(items, { includedCategories, excludedCategories, searchQuery }),
    [items, includedCategories, excludedCategories, searchQuery]
  )

  if (error) {
    return <div className="error">Error: {error}</div>
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-top">
          <h1 className="logo">Gooners</h1>
          <DataFreshness auctions={auctions} selectedId={selectedAuctionId} />
        </div>
        <p className="tagline">A better way to browse Cannon's Auctions</p>
        <AuctionPicker
          auctions={auctions}
          selectedId={selectedAuctionId}
          onSelect={setSelectedAuctionId}
        />
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
        <FilterBar
          categories={categories}
          includedCategories={includedCategories}
          excludedCategories={excludedCategories}
          onToggleIncluded={toggleIncluded}
          onToggleExcluded={toggleExcluded}
          onClearIncluded={clearIncluded}
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
