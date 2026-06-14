// @ts-nocheck
import { SORT_OPTIONS } from '../utils/sort'

export function SortBar({ value, onChange, showForYou = false }) {
  const options = SORT_OPTIONS.filter(o => o.key !== 'foryou' || showForYou)
  return (
    <div className="sort-bar">
      <label className="sort-icon-label" htmlFor="sort-select" title="Sort order" aria-label="Sort">↕</label>
      <select
        id="sort-select"
        className="sort-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}