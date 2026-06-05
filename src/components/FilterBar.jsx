import { useState } from 'react'

function GroupSection({ group, excludedCategories, excludedGroups, onToggle, onShowOnly, onHideGroup, onShowGroup, startExpanded }) {
  const [expanded, setExpanded] = useState(startExpanded)
  // A group can be hidden coarsely (its name in excludedGroups) or finely (each
  // raw chip excluded). Coarse hiding also covers future raw categories that
  // normalize into the group, so it's how the group-level button works.
  const groupHidden = excludedGroups.includes(group.group)
  const shown = group.rawCategories.filter(c => !excludedCategories.includes(c.name))
  const hidden = group.rawCategories.filter(c => excludedCategories.includes(c.name))
  const isHidden = groupHidden || shown.length === 0
  const shownCount = groupHidden ? 0 : shown.reduce((s, c) => s + c.count, 0)
  const rawNames = group.rawCategories.map(c => c.name)

  return (
    <div className={`filter-group ${isHidden ? 'all-hidden' : ''}`}>
      <div className="filter-group-header">
        <button
          className="filter-group-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="filter-group-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="filter-group-name">{group.group}</span>
          <span className="filter-group-count">
            {isHidden ? `hidden (${group.totalCount})` : shownCount}
          </span>
        </button>
        <button
          className="filter-action"
          onClick={() => isHidden
            ? onShowGroup(group.group, rawNames)
            : onHideGroup(group.group)
          }
        >
          {isHidden ? 'show' : 'hide'}
        </button>
      </div>

      {expanded && !groupHidden && (
        <div className="filter-group-body">
          <div className="filter-chips">
            {shown.map(({ name, count }) => (
              <span key={name} className="filter-chip-wrap">
                <button
                  className="filter-chip shown"
                  onClick={() => onToggle(name)}
                >
                  {name}
                  <span className="chip-count">{count}</span>
                </button>
                <button
                  className="filter-chip-only"
                  title={`Show only ${name}`}
                  aria-label={`Show only ${name}`}
                  onClick={() => onShowOnly(name)}
                >
                  only
                </button>
              </span>
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
  excludedGroups,
  onToggleExcluded,
  onHideGroup,
  onShowGroup,
  onHideAll,
  onShowAll,
  onShowOnly,
}) {
  const totalItems = groupedCategories.reduce((s, g) => s + g.totalCount, 0)
  const allRawNames = groupedCategories.flatMap(g => g.rawCategories.map(c => c.name))
  const isGroupHidden = (g) => excludedGroups.includes(g.group)
  // A group counts as fully hidden when its name is excluded OR every raw chip is.
  const allHidden = groupedCategories.length > 0 && groupedCategories.every(g =>
    isGroupHidden(g) || g.rawCategories.every(c => excludedCategories.includes(c.name))
  )
  const noneHidden = excludedGroups.length === 0
    && !groupedCategories.some(g => g.rawCategories.some(c => excludedCategories.includes(c.name)))
  const excludedCount = groupedCategories.reduce((s, g) =>
    isGroupHidden(g)
      ? s + g.totalCount
      : s + g.rawCategories.filter(c => excludedCategories.includes(c.name)).reduce((s2, c) => s2 + c.count, 0)
  , 0)

  // Isolate one category — exclude every other category across all groups.
  const handleShowOnly = (name) => onShowOnly(name, allRawNames)

  const [open, setOpen] = useState(false)

  return (
    <div className="filter-bar">
      <div className="filter-bar-header">
        <button className="filter-bar-toggle" onClick={() => setOpen(!open)}>
          <span className="filter-label-text">Categories</span>
          <span className="filter-summary">{totalItems - excludedCount} of {totalItems}</span>
          <span className="filter-bar-arrow">{open ? '▾' : '▸'}</span>
        </button>
        {!noneHidden && (
          <button className="filter-action" onClick={onShowAll}>show all</button>
        )}
        {!allHidden && (
          <button className="filter-action" onClick={onHideAll}>hide all</button>
        )}
      </div>
      {open && (
        <div className="filter-bar-body">
          {groupedCategories.map(group => (
            <GroupSection
              key={group.group}
              group={group}
              excludedCategories={excludedCategories}
              excludedGroups={excludedGroups}
              onToggle={onToggleExcluded}
              onShowOnly={handleShowOnly}
              onHideGroup={onHideGroup}
              onShowGroup={onShowGroup}
              startExpanded={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}
