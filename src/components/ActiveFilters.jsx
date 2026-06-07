function Chip({ label, onRemove }) {
  return (
    <span className="af-chip">
      {label}
      <button
        type="button"
        className="af-chip-remove"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
      >×</button>
    </span>
  )
}

export function ActiveFilters({
  searchQuery, onClearSearch,
  localOnly, onClearLocal,
  archiveMode, onClearArchive,
  decisionView, onClearDecision,
  showMyBidsOnly, onClearMyBids,
  bestDeals, onClearBestDeals,
  minPrice, maxPrice, onClearPrice,
  minBids, maxBids, onClearBids,
  minBidders, maxBidders, onClearBidders,
  minHours, maxHours, onClearHours,
  hasComp, onClearComp,
  hasCannonsComp, onClearCannonsComp,
  hasEnrichment, onClearEnrichment,
  excludedCategoryCount, onClearCategories,
  excludedAuctionCount, onClearAuctions,
  onClearAll,
}) {
  const chips = []

  if (searchQuery?.trim()) {
    const q = searchQuery.trim()
    chips.push({ label: `"${q.length > 20 ? q.slice(0, 20) + '…' : q}"`, onRemove: onClearSearch })
  }
  if (localOnly) chips.push({ label: 'Richmond only', onRemove: onClearLocal })
  if (archiveMode === 'archived') chips.push({ label: 'Archived only', onRemove: onClearArchive })
  if (archiveMode === 'both') chips.push({ label: 'All auctions', onRemove: onClearArchive })
  if (decisionView === 'favorites') chips.push({ label: 'Favorites', onRemove: onClearDecision })
  if (decisionView === 'ignored') chips.push({ label: 'Ignored', onRemove: onClearDecision })
  if (showMyBidsOnly) chips.push({ label: 'My Bids', onRemove: onClearMyBids })
  if (bestDeals) chips.push({ label: 'Best deals', onRemove: onClearBestDeals })
  if (minPrice !== null || maxPrice !== null) {
    const lo = minPrice != null ? `$${minPrice}` : '$0'
    const hi = maxPrice != null ? `$${maxPrice}` : 'any'
    chips.push({ label: `Price: ${lo}–${hi}`, onRemove: onClearPrice })
  }
  if (minBids !== null || maxBids !== null) {
    chips.push({ label: `Bids: ${minBids ?? 0}–${maxBids ?? '∞'}`, onRemove: onClearBids })
  }
  if (minBidders !== null || maxBidders !== null) {
    chips.push({ label: `Bidders: ${minBidders ?? 0}–${maxBidders ?? '∞'}`, onRemove: onClearBidders })
  }
  if (minHours !== null || maxHours !== null) {
    chips.push({ label: `Ends: ${minHours ?? 0}–${maxHours ?? '∞'}h`, onRemove: onClearHours })
  }
  if (hasComp) chips.push({ label: 'Has eBay comp', onRemove: onClearComp })
  if (hasCannonsComp) chips.push({ label: "Has Cannon's comp", onRemove: onClearCannonsComp })
  if (hasEnrichment) chips.push({ label: '✨ AI identified', onRemove: onClearEnrichment })
  if (excludedCategoryCount > 0) {
    chips.push({ label: `${excludedCategoryCount} categories hidden`, onRemove: onClearCategories })
  }
  if (excludedAuctionCount > 0) {
    chips.push({ label: `${excludedAuctionCount} auctions hidden`, onRemove: onClearAuctions })
  }

  if (chips.length === 0) return null

  return (
    <div className="active-filters-bar">
      {chips.map((chip, i) => (
        <Chip key={i} label={chip.label} onRemove={chip.onRemove} />
      ))}
      <button type="button" className="af-clear-all" onClick={onClearAll}>
        Clear all
      </button>
    </div>
  )
}
