import { useState } from 'react'
import { RangeFilters } from './RangeFilters'
import { HasFilters } from './HasFilters'
import { AuctionFilter } from './AuctionFilter'
import { FilterBar } from './FilterBar'

function Accordion({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="fp-accordion">
      <button
        type="button"
        className="fp-accordion-header"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="fp-accordion-title">{title}</span>
        <span className="fp-accordion-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="fp-accordion-body">{children}</div>}
    </div>
  )
}

export function FilterPanel({
  open,
  onClose,
  // View controls
  archiveMode,
  onArchiveModeChange,
  decisionView,
  onDecisionViewChange,
  localOnly,
  onLocalOnlyChange,
  showMyBidsOnly,
  onShowMyBidsOnlyChange,
  bestDeals,
  onBestDealsToggle,
  viewMode,
  onViewModeChange,
  favoriteCount,
  ignoredCount,
  cannonBidsLinked,
  cannonBidCount,
  cannonBidsLoading,
  // Range filters
  items,
  minPrice, maxPrice, onMinPriceChange, onMaxPriceChange,
  minBids, maxBids, onMinBidsChange, onMaxBidsChange,
  minBidders, maxBidders, onMinBiddersChange, onMaxBiddersChange,
  minHours, maxHours, onMinHoursChange, onMaxHoursChange,
  // Has filters
  hasEbayComp, onHasEbayCompChange,
  hasCannonsComp, onHasCannonsCompChange,
  hasEnrichment, onHasEnrichmentChange,
  // Auction filter
  auctions, excludedAuctions,
  onToggleAuction, onShowAllAuctions, onShowOnlyAuction,
  onHideSource, onShowSource,
  archiveLoading, archiveError,
  // Category filter
  groupedCategories, excludedCategories, excludedGroups,
  onToggleExcluded, onHideGroup, onShowGroup, onHideAll, onShowAll, onShowOnly,
}) {
  return (
    <>
      {/* Mobile backdrop — tapping closes the panel */}
      <div
        className={`filter-backdrop${open ? ' filter-backdrop--visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />

      <aside className={`filter-sidebar${open ? ' filter-sidebar--open' : ''}`} aria-label="Filters">
        <div className="filter-panel-header">
          <span className="filter-panel-title">Filters</span>
          <button
            type="button"
            className="filter-panel-close"
            onClick={onClose}
            aria-label="Close filters"
          >✕</button>
        </div>

        {/* View options — archive mode, favorites, view layout, quick toggles */}
        <Accordion title="View" defaultOpen={true}>
          <div className="fp-view-section">
            <div className="fp-control-row">
              <span className="fp-control-label">Auctions</span>
              <div className="archive-segmented" role="group" aria-label="Which auctions to show">
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
                    onClick={() => onArchiveModeChange(opt.value)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>

            <div className="fp-control-row">
              <span className="fp-control-label">Show</span>
              <div className="archive-segmented" role="group" aria-label="Which items to show">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'favorites', label: favoriteCount > 0 ? `Favorites (${favoriteCount})` : 'Favorites' },
                  { value: 'ignored', label: ignoredCount > 0 ? `Ignored (${ignoredCount})` : 'Ignored' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`segmented-option${decisionView === opt.value ? ' active' : ''}`}
                    aria-pressed={decisionView === opt.value}
                    onClick={() => onDecisionViewChange(opt.value)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>

            <label className="local-toggle">
              <input
                type="checkbox"
                checked={localOnly}
                onChange={e => onLocalOnlyChange(e.target.checked)}
              />
              <span>Richmond area only</span>
            </label>

            <div className="fp-pill-row">
              {cannonBidsLinked && (
                <button
                  type="button"
                  className={`deals-toggle${showMyBidsOnly ? ' active' : ''}`}
                  onClick={() => onShowMyBidsOnlyChange(v => !v)}
                >
                  {cannonBidsLoading
                    ? 'My Bids…'
                    : cannonBidCount > 0
                      ? `My Bids (${cannonBidCount})`
                      : 'My Bids'}
                </button>
              )}
              <button
                type="button"
                className={`deals-toggle${bestDeals ? ' active' : ''}`}
                onClick={onBestDealsToggle}
              >
                Best deals
              </button>
            </div>

            <div className="fp-control-row">
              <span className="fp-control-label">Layout</span>
              <div className="archive-segmented" role="group" aria-label="Grid layout">
                {[
                  { value: 'grid', label: 'Grid' },
                  { value: 'compact', label: 'Compact' },
                ].map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`segmented-option${viewMode === opt.value ? ' active' : ''}`}
                    aria-pressed={viewMode === opt.value}
                    onClick={() => onViewModeChange(opt.value)}
                  >{opt.label}</button>
                ))}
              </div>
            </div>
          </div>
        </Accordion>

        {/* Price & bidding range sliders */}
        <Accordion title="Price & Bidding" defaultOpen={true}>
          <RangeFilters
            items={items}
            minPrice={minPrice} maxPrice={maxPrice}
            onMinPriceChange={onMinPriceChange} onMaxPriceChange={onMaxPriceChange}
            minBids={minBids} maxBids={maxBids}
            onMinBidsChange={onMinBidsChange} onMaxBidsChange={onMaxBidsChange}
            minBidders={minBidders} maxBidders={maxBidders}
            onMinBiddersChange={onMinBiddersChange} onMaxBiddersChange={onMaxBiddersChange}
            minHours={minHours} maxHours={maxHours}
            onMinHoursChange={onMinHoursChange} onMaxHoursChange={onMaxHoursChange}
          />
        </Accordion>

        {/* Data availability checkboxes (Has) */}
        <HasFilters
          hasEbayComp={hasEbayComp}
          onHasEbayCompChange={onHasEbayCompChange}
          hasCannonsComp={hasCannonsComp}
          onHasCannonsCompChange={onHasCannonsCompChange}
          hasEnrichment={hasEnrichment}
          onHasEnrichmentChange={onHasEnrichmentChange}
        />

        {/* Per-auction visibility */}
        <AuctionFilter
          auctions={auctions}
          excludedAuctions={excludedAuctions}
          onToggle={onToggleAuction}
          onShowAll={onShowAllAuctions}
          onShowOnly={onShowOnlyAuction}
          onHideSource={onHideSource}
          onShowSource={onShowSource}
        />
        {archiveLoading && <div className="inline-status">Loading archived auctions…</div>}
        {archiveError && <div className="inline-error">Archived auctions failed: {archiveError}</div>}

        {/* Category inclusion/exclusion tree */}
        <FilterBar
          groupedCategories={groupedCategories}
          excludedCategories={excludedCategories}
          excludedGroups={excludedGroups}
          onToggleExcluded={onToggleExcluded}
          onHideGroup={onHideGroup}
          onShowGroup={onShowGroup}
          onHideAll={onHideAll}
          onShowAll={onShowAll}
          onShowOnly={onShowOnly}
        />
      </aside>
    </>
  )
}
