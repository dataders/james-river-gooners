// Global resale-margin preference. Lives in the sidebar so the max-bid
// calculator in the item detail panel can stay focused on the all-in cost
// instead of showing a slider on every item (see #88/#89).
export function MarginPreference({ value, onChange }) {
  return (
    <div className="filter-section margin-pref">
      <div className="filter-label">
        <span className="filter-label-text">Resale margin</span>
        <span className="filter-summary">applied to max-bid calc</span>
      </div>
      <div className="margin-pref-slider-group">
        <input
          type="range"
          min="0"
          max="60"
          step="5"
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="roi-margin-slider"
          aria-label="Target resale margin"
        />
        <span className="roi-margin-pct">{value}%</span>
      </div>
    </div>
  )
}
