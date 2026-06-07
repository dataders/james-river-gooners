import { useState, useEffect } from 'react'

export function SearchBar({ value, onChange, semanticStatus }) {
  const [localValue, setLocalValue] = useState(value)

  // Sync draft when the committed search changes externally
  // (clear-all, image search, URL-loaded query).
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const submit = () => {
    const trimmed = localValue.trim()
    if (trimmed !== value) onChange(trimmed)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') setLocalValue(value) // discard draft
  }

  const handleClear = () => {
    setLocalValue('')
    onChange('')
  }

  // A "draft" exists whenever the box differs from the last committed search.
  const isDraft = localValue.trim() !== value

  return (
    <div className="search-bar-wrap">
      <input
        type="text"
        className="search-bar"
        placeholder="Search items..."
        value={localValue}
        onChange={e => setLocalValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {!isDraft && semanticStatus === 'loading' && (
        <span
          className="semantic-badge semantic-badge--loading"
          style={value ? { right: 38 } : undefined}
          title="Downloading AI search model (cached in browser after first use)"
        >
          AI ↓
        </span>
      )}
      {!isDraft && semanticStatus === 'ready' && (
        <span
          className="semantic-badge semantic-badge--ready"
          style={value ? { right: 38 } : undefined}
          title="Semantic search active"
        >
          AI ✓
        </span>
      )}
      {isDraft && localValue && (
        <button
          type="button"
          className="search-submit"
          aria-label="Search"
          onClick={submit}
        >
          →
        </button>
      )}
      {!isDraft && value && (
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
