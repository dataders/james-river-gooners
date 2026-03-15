import { useState, useRef } from 'react'

export function SearchBar({ value, onChange }) {
  const [localValue, setLocalValue] = useState(value)
  const timeoutRef = useRef(null)

  const handleChange = (e) => {
    const val = e.target.value
    setLocalValue(val)
    clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => onChange(val), 200)
  }

  return (
    <input
      type="text"
      className="search-bar"
      placeholder="Search items..."
      value={localValue}
      onChange={handleChange}
    />
  )
}
