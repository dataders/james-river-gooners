export function FilterBar({
  categories,
  includedCategories,
  excludedCategories,
  onToggleIncluded,
  onToggleExcluded,
  onClearIncluded,
}) {
  const isAllSelected = includedCategories.length === 0

  return (
    <div className="filter-bar">
      <div className="filter-row">
        <button
          className={`filter-pill ${isAllSelected ? 'active' : ''}`}
          onClick={onClearIncluded}
        >
          All
        </button>
        {categories.map(({ name, count }) => {
          const isIncluded = isAllSelected || includedCategories.includes(name)
          const isExcluded = excludedCategories.includes(name)
          return (
            <button
              key={name}
              className={`filter-pill ${isExcluded ? 'excluded' : isIncluded && !isAllSelected ? 'active' : ''}`}
              onClick={() => {
                if (isExcluded) {
                  // Un-exclude first
                  onToggleExcluded(name)
                } else if (isAllSelected) {
                  // Clicking while "All" is active: exclude this category
                  onToggleExcluded(name)
                } else if (includedCategories.includes(name)) {
                  onToggleIncluded(name)
                } else {
                  onToggleIncluded(name)
                }
              }}
            >
              {isExcluded && <span className="x-mark">✕ </span>}
              {name}
              <span className="pill-count">{count}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
