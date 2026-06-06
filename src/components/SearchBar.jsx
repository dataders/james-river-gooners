import { useState, useRef } from 'react'

export function SearchBar({ value, onChange, semanticStatus, onCameraClick }) {
  const [localValue, setLocalValue] = useState(value)
  const timeoutRef = useRef(null)

  const handleChange = (e) => {
    const val = e.target.value
    setLocalValue(val)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => onChange(val), 200)
  }

  const handleClear = () => {
    clearTimeout(timeoutRef.current)
    setLocalValue('')
    onChange('')
  }

  return (
    <div className="search-bar-wrap">
      {onCameraClick && (
        <button
          type="button"
          className="search-camera-btn"
          aria-label="Search by photo"
          title="Find similar lots by photo"
          onClick={onCameraClick}
        >
          📷
        </button>
      )}
      <input
        type="text"
        className={`search-bar${onCameraClick ? ' search-bar--with-camera' : ''}`}
        placeholder="Search items..."
        value={localValue}
        onChange={handleChange}
      />
      {semanticStatus === 'loading' && (
        <span
          className="semantic-badge semantic-badge--loading"
          style={localValue ? { right: 38 } : undefined}
          title="Downloading AI search model (~40 MB, cached after first load)"
        >
          AI ↓
        </span>
      )}
      {semanticStatus === 'ready' && (
        <span
          className="semantic-badge semantic-badge--ready"
          style={localValue ? { right: 38 } : undefined}
          title="Semantic (CLIP) search active"
        >
          AI ✓
        </span>
      )}
      {localValue && (
        <button
          type="button"
          className="search-clear"
          aria-label="Clear search"
          onClick={handleClear}
        >
          ×
        </button>
      )}
    </div>
  )
}
