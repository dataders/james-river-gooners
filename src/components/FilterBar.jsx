// @ts-nocheck
import { useState } from 'react'

function GroupSection({
  group, excludedCategories, excludedGroups, baselineExcludedGroups, baselineExcludedCategories,
  onToggle, onShowOnly, onHideGroup, onShowGroup,
  onAddBaselineGroup, onRemoveBaselineGroup, onAddBaselineCategory, onRemoveBaselineCategory,
  startExpanded,
}) {
  const [expanded, setExpanded] = useState(startExpanded)
  // A group can be hidden coarsely (its name in excludedGroups) or finely (each
  // raw chip excluded). Coarse hiding also covers future raw categories that
  // normalize into the group, so it's how the group-level button works.
  const groupHidden = excludedGroups.includes(group.group)
  // "Always hidden" = promoted into the permanent baseline. It seeds every visit
  // and renders with a lock + restore instead of the temporary show/hide pair.
  const baselineHidden = baselineExcludedGroups.includes(group.group)
  const shown = group.rawCategories.filter(c => !excludedCategories.includes(c.name))
  // Hidden chips render after shown ones; within hidden, the permanently
  // "always hidden" (baseline-locked) chips sink to the very bottom.
  const hidden = group.rawCategories
    .filter(c => excludedCategories.includes(c.name))
    .sort((a, b) =>
      (baselineExcludedCategories.includes(a.name) ? 1 : 0) -
      (baselineExcludedCategories.includes(b.name) ? 1 : 0)
    )
  const isHidden = groupHidden || shown.length === 0
  const shownCount = groupHidden ? 0 : shown.reduce((s, c) => s + c.count, 0)
  const rawNames = group.rawCategories.map(c => c.name)

  return (
    <div className={`filter-group ${isHidden ? 'all-hidden' : ''}${baselineHidden ? ' always-hidden' : ''}`}>
      <div className="filter-group-header">
        <button
          className="filter-group-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="filter-group-arrow">{expanded ? '▾' : '▸'}</span>
          {baselineHidden && <span className="lock-mark" aria-hidden="true">🔒</span>}
          <span className="filter-group-name">{group.group}</span>
          <span className="filter-group-count">
            {baselineHidden ? 'always hidden' : isHidden ? `hidden (${group.totalCount})` : shownCount}
          </span>
        </button>
        {baselineHidden ? (
          <button className="filter-action" onClick={() => onRemoveBaselineGroup(group.group)}>restore</button>
        ) : isHidden ? (
          <span className="filter-group-actions">
            <button className="filter-action" onClick={() => onShowGroup(group.group, rawNames)}>show</button>
            <button
              className="filter-action filter-action--promote"
              title={`Never show ${group.group} again`}
              onClick={() => onAddBaselineGroup(group.group)}
            >never show this</button>
          </span>
        ) : (
          <button className="filter-action" onClick={() => onHideGroup(group.group)}>hide</button>
        )}
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
            {hidden.map(({ name, count }) => {
              const locked = baselineExcludedCategories.includes(name)
              return (
                <span key={name} className="filter-chip-wrap">
                  <button
                    className="filter-chip hidden"
                    onClick={() => onToggle(name)}
                  >
                    <span className="x-mark">{locked ? '🔒' : '✕'}</span>
                    {name}
                    <span className="chip-count">{count}</span>
                  </button>
                  <button
                    type="button"
                    className={`filter-chip-promote${locked ? ' locked' : ''}`}
                    title={locked ? `Restore ${name}` : `Never show ${name} again`}
                    aria-label={locked ? `Restore ${name}` : `Never show ${name} again`}
                    onClick={() => locked ? onRemoveBaselineCategory(name) : onAddBaselineCategory(name)}
                  >🔒</button>
                </span>
              )
            })}
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
  baselineExcludedGroups = [],
  baselineExcludedCategories = [],
  onToggleExcluded,
  onHideGroup,
  onShowGroup,
  onHideAll,
  onShowAll,
  onShowOnly,
  onAddBaselineGroup,
  onRemoveBaselineGroup,
  onAddBaselineCategory,
  onRemoveBaselineCategory,
}) {
  const totalItems = groupedCategories.reduce((s, g) => s + g.totalCount, 0)
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
  const handleShowOnly = (name) => onShowOnly(name, groupedCategories)

  // Permanently "always hidden" groups sink to the bottom of the list (stable
  // sort keeps the original order among non-hidden and among hidden groups).
  const orderedGroups = [...groupedCategories].sort((a, b) =>
    (baselineExcludedGroups.includes(a.group) ? 1 : 0) -
    (baselineExcludedGroups.includes(b.group) ? 1 : 0)
  )

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
          {orderedGroups.map(group => (
            <GroupSection
              key={group.group}
              group={group}
              excludedCategories={excludedCategories}
              excludedGroups={excludedGroups}
              baselineExcludedGroups={baselineExcludedGroups}
              baselineExcludedCategories={baselineExcludedCategories}
              onToggle={onToggleExcluded}
              onShowOnly={handleShowOnly}
              onHideGroup={onHideGroup}
              onShowGroup={onShowGroup}
              onAddBaselineGroup={onAddBaselineGroup}
              onRemoveBaselineGroup={onRemoveBaselineGroup}
              onAddBaselineCategory={onAddBaselineCategory}
              onRemoveBaselineCategory={onRemoveBaselineCategory}
              startExpanded={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}