// Minimum-estimated-profit filter (#101). A lot's estimated profit is its eBay
// comp median minus the all-in cost (bid + buyer's premium + sales tax), so
// this control needs comp data and can only keep lots that have it — it lives
// in the sidebar as a toggle + dollar input rather than a histogram slider
// (RangeFilters operates on the item list alone, which carries no comp prices).
const DEFAULT_THRESHOLD = 100

export function MinProfitFilter({ value, onChange }) {
  const enabled = value != null
  const amount = value ?? DEFAULT_THRESHOLD

  return (
    <div className="filter-section min-profit-filter">
      <label className="filter-label min-profit-toggle">
        <span className="filter-label-text">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => onChange(e.target.checked ? DEFAULT_THRESHOLD : null)}
          />
          {' '}Min profit
        </span>
        <span className="min-profit-amount">
          $
          <input
            type="number"
            min="0"
            step="25"
            value={amount}
            disabled={!enabled}
            onChange={e => {
              const n = Math.max(0, Math.round(Number(e.target.value)))
              onChange(Number.isFinite(n) ? n : 0)
            }}
            aria-label="Minimum estimated profit in dollars"
          />
        </span>
      </label>
      <p className="min-profit-hint">
        Hides lots whose eBay comp median minus all-in cost is below this.
        Only lots with comp data can qualify.
      </p>
    </div>
  )
}
