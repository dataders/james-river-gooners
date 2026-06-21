// @ts-check
import { useState } from 'react'

/**
 * @param {{
 *   group: { group: string, totalCount: number, rawCategories: {name: string, count: number}[] },
 *   baselineExcludedGroups: string[],
 *   baselineExcludedCategories: string[],
 *   onToggleBaselineGroup: (group: string) => void,
 *   onToggleBaselineCategory: (cat: string) => void,
 * }} props
 */
function GroupSection({ group, baselineExcludedGroups, baselineExcludedCategories, onToggleBaselineGroup, onToggleBaselineCategory }) {
  const [expanded, setExpanded] = useState(false)
  const groupHidden = baselineExcludedGroups.includes(group.group)
  const shown = group.rawCategories.filter(c => !baselineExcludedCategories.includes(c.name))
  const hidden = group.rawCategories.filter(c => baselineExcludedCategories.includes(c.name))
  const isHidden = groupHidden || shown.length === 0
  const shownCount = groupHidden ? 0 : shown.reduce((s, c) => s + c.count, 0)

  return (
    <div className={`filter-group${isHidden ? ' all-hidden' : ''}`}>
      <div className="filter-group-header">
        <button
          type="button"
          className="filter-group-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
        >
          <span className="filter-group-arrow" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span className="filter-group-name">{group.group}</span>
          <span className="filter-group-count">
            {isHidden ? `hidden (${group.totalCount})` : shownCount}
          </span>
        </button>
        <button
          type="button"
          className="filter-action"
          onClick={() => onToggleBaselineGroup(group.group)}
        >
          {isHidden ? 'show' : 'hide'}
        </button>
      </div>

      {expanded && !groupHidden && (
        <div className="filter-group-body">
          <div className="filter-chips">
            {shown.map(({ name, count }) => (
              <button
                key={name}
                type="button"
                className="filter-chip shown"
                onClick={() => onToggleBaselineCategory(name)}
              >
                {name}
                <span className="chip-count">{count}</span>
              </button>
            ))}
            {hidden.map(({ name, count }) => (
              <button
                key={name}
                type="button"
                className="filter-chip hidden"
                onClick={() => onToggleBaselineCategory(name)}
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

/**
 * @param {{
 *   groupedCategories: {group: string, totalCount: number, rawCategories: {name: string, count: number}[]}[],
 *   baselineExcludedGroups: string[],
 *   baselineExcludedCategories: string[],
 *   onToggleBaselineGroup: (group: string) => void,
 *   onToggleBaselineCategory: (cat: string) => void,
 * }} props
 */
export function CategoryPrefsList({ groupedCategories, baselineExcludedGroups, baselineExcludedCategories, onToggleBaselineGroup, onToggleBaselineCategory }) {
  return (
    <div className="catprefs-list">
      {groupedCategories.map(group => (
        <GroupSection
          key={group.group}
          group={group}
          baselineExcludedGroups={baselineExcludedGroups}
          baselineExcludedCategories={baselineExcludedCategories}
          onToggleBaselineGroup={onToggleBaselineGroup}
          onToggleBaselineCategory={onToggleBaselineCategory}
        />
      ))}
    </div>
  )
}
