import { SORT_OPTIONS } from '../utils/sort'

export function SortBar({ value, onChange }) {
  return (
    <div className="sort-bar">
      <label className="sort-label" htmlFor="sort-select">Sort</label>
      <select
        id="sort-select"
        className="sort-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
