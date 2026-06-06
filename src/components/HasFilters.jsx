// Sidebar "Has" checkbox group. Replaces the standalone top-bar pill toggles
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
        <span className="filter-label-text">Has</span>
      </div>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasEbayComp}
          onChange={e => onHasEbayCompChange(e.target.checked)}
        />
        <span>eBay comp</span>
      </label>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasCannonsComp}
          onChange={e => onHasCannonsCompChange(e.target.checked)}
        />
        <span>Auction comp</span>
      </label>
      <label className="has-filter-row">
        <input
          type="checkbox"
          checked={hasEnrichment}
          onChange={e => onHasEnrichmentChange(e.target.checked)}
        />
        <span>✨ AI product enrichment</span>
      </label>
    </div>
  )
}
