import { useState } from 'react'

function GroupSection({ group, excludedCategories, onToggle, onHideGroup, onShowGroup, startExpanded }) {
  const [expanded, setExpanded] = useState(startExpanded)
  const shown = group.rawCategories.filter(c => !excludedCategories.includes(c.name))
  const hidden = group.rawCategories.filter(c => excludedCategories.includes(c.name))
  const allHidden = shown.length === 0
  const shownCount = shown.reduce((s, c) => s + c.count, 0)

  return (
    <div className={`filter-group ${allHidden ? 'all-hidden' : ''}`}>
      <div className="filter-group-header">
        <button
          className="filter-group-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="filter-group-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="filter-group-name">{group.group}</span>
          <span className="filter-group-count">
            {allHidden ? `hidden (${group.totalCount})` : shownCount}
          </span>
        </button>
        <button
          className="filter-action"
          onClick={() => allHidden
            ? onShowGroup(group.rawCategories.map(c => c.name))
            : onHideGroup(group.rawCategories.map(c => c.name))
          }
        >
          {allHidden ? 'show' : 'hide'}
        </button>
      </div>

      {expanded && (
        <div className="filter-group-body">
          <div className="filter-chips">
            {shown.map(({ name, count }) => (
              <button
                key={name}
                className="filter-chip shown"
                onClick={() => onToggle(name)}
              >
                {name}
                <span className="chip-count">{count}</span>
              </button>
            ))}
            {hidden.map(({ name, count }) => (
              <button
                key={name}
                className="filter-chip hidden"
                onClick={() => onToggle(name)}
              >
                <span className="x-mark">✕</span>
                {name}
                <span className="chip-count">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function FilterBar({
  groupedCategories,
  excludedCategories,
  onToggleExcluded,
  onHideAll,
  onShowAll,
}) {
  const totalItems = groupedCategories.reduce((s, g) => s + g.totalCount, 0)
  const allRawNames = groupedCategories.flatMap(g => g.rawCategories.map(c => c.name))
  const allHidden = allRawNames.length > 0 && allRawNames.every(n => excludedCategories.includes(n))
  const noneHidden = !allRawNames.some(n => excludedCategories.includes(n))
  const excludedCount = groupedCategories.reduce((s, g) =>
    s + g.rawCategories.filter(c => excludedCategories.includes(c.name)).reduce((s2, c) => s2 + c.count, 0)
  , 0)

  const handleHideGroup = (names) => {
    for (const name of names) {
      if (!excludedCategories.includes(name)) {
        onToggleExcluded(name)
      }
    }
  }

  const handleShowGroup = (names) => {
    for (const name of names) {
      if (excludedCategories.includes(name)) {
        onToggleExcluded(name)
      }
    }
  }

  const [open, setOpen] = useState(false)

  return (
    <div className="filter-bar">
      <button className="filter-bar-toggle" onClick={() => setOpen(!open)}>
        <span className="filter-label-text">Categories</span>
        {!noneHidden && (
          <span className="filter-action" role="button" onClick={e => { e.stopPropagation(); onShowAll() }}>show all</span>
        )}
        {!allHidden && (
          <span className="filter-action" role="button" onClick={e => { e.stopPropagation(); onHideAll() }}>hide all</span>
        )}
        <span className="filter-summary">{totalItems - excludedCount} of {totalItems}</span>
        <span className="filter-bar-arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="filter-bar-body">
          {groupedCategories.map(group => (
            <GroupSection
              key={group.group}
              group={group}
              excludedCategories={excludedCategories}
              onToggle={onToggleExcluded}
              onHideGroup={handleHideGroup}
              onShowGroup={handleShowGroup}
              startExpanded={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}
