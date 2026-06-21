// @ts-nocheck
export function HasFilters({
  hasEbayComp,
  onHasEbayCompChange,
  hasCannonsComp,
  onHasCannonsCompChange,
  hasEnrichment,
  onHasEnrichmentChange,
}) {
  const filters = [
    { label: 'eBay resale data', checked: hasEbayComp, onChange: onHasEbayCompChange },
    { label: "Cannon's sold history", checked: hasCannonsComp, onChange: onHasCannonsCompChange },
    { label: '✨ Brand & model known', checked: hasEnrichment, onChange: onHasEnrichmentChange },
  ]
  return (
    <div className="has-filters">
      {filters.map(({ label, checked, onChange }) => (
        <label key={label} className="has-filter-row">
          <span className="has-filter-label">{label}</span>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => onChange(e.target.checked)}
          />
        </label>
      ))}
    </div>
  )
}