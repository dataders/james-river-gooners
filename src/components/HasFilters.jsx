// Sidebar "Comps" checkbox group. Replaces the standalone top-bar pill toggles
// (Has eBay comp / Has auction comp / ✨ Identified) with a single labeled
// section of checkboxes so the resale-data presence filters live together.
export function HasFilters({
  hasEbayComp,
  onHasEbayCompChange,
  hasCannonsComp,
  onHasCannonsCompChange,
  hasEnrichment,
  onHasEnrichmentChange,
}) {
  return (
    <div className="filter-section has-filters">
      <div className="filter-label">
        <span className="filter-label-text">Comps</span>
      </div>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasEbayComp}
          onChange={e => onHasEbayCompChange(e.target.checked)}
        />
        <span>eBay</span>
      </label>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasCannonsComp}
          onChange={e => onHasCannonsCompChange(e.target.checked)}
        />
        <span>Auctions</span>
      </label>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasEnrichment}
          onChange={e => onHasEnrichmentChange(e.target.checked)}
        />
        <span>✨ Claude</span>
      </label>
    </div>
  )
}
