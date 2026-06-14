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
    { label: 'eBay resale data', sublabel: 'Shows estimated sell price', checked: hasEbayComp, onChange: onHasEbayCompChange },
    { label: "Cannon's sold history", sublabel: 'Similar lots have sold before', checked: hasCannonsComp, onChange: onHasCannonsCompChange },
    { label: '✨ Brand & model known', sublabel: 'AI has identified the item', checked: hasEnrichment, onChange: onHasEnrichmentChange },
  ]
  return (
    <div className="has-filters">
      {filters.map(({ label, sublabel, checked, onChange }) => (
        <label key={label} className="has-filter-row">
          <div className="has-filter-text">
            <span className="has-filter-label">{label}</span>
            <span className="has-filter-sublabel">{sublabel}</span>
          </div>
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