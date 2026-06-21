// @ts-check
import { useState } from 'react'

/**
 * @param {{ c: { name: string, count: number }, baselineExcludedCategories: string[], onToggleBaselineCategory: (cat: string) => void }} props
 */
function CategoryRow({ c, baselineExcludedCategories, onToggleBaselineCategory }) {
  const hidden = baselineExcludedCategories.includes(c.name)
  return (
    <label className="catprefs-cat-row">
      <span className={`catprefs-cat-name${hidden ? ' catprefs-cat-name--hidden' : ''}`}>
        {c.name}
      </span>
      <span className="catprefs-cat-count">{c.count}</span>
      <span className="catprefs-toggle">
        <input type="checkbox" checked={hidden} onChange={() => onToggleBaselineCategory(c.name)} />
        <span className="catprefs-toggle-track"><span className="catprefs-toggle-thumb" /></span>
      </span>
    </label>
  )
}

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
  const hidden = baselineExcludedGroups.includes(group.group)

  return (
    <div className={`catprefs-group${hidden ? ' catprefs-group--hidden' : ''}`}>
      <div className="catprefs-group-header">
        <button
          type="button"
          className="catprefs-expand-btn"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.group}`}
        >
          <span className="catprefs-expand-arrow" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          <span className={`catprefs-group-name${hidden ? ' catprefs-group-name--hidden' : ''}`}>
            {group.group}
          </span>
          <span className="catprefs-group-count">{group.totalCount} lots</span>
        </button>
        <label
          className="catprefs-toggle"
          title={hidden ? 'Always hidden — click to show' : 'Click to always hide'}
        >
          <input
            type="checkbox"
            checked={hidden}
            onChange={() => onToggleBaselineGroup(group.group)}
          />
          <span className="catprefs-toggle-track"><span className="catprefs-toggle-thumb" /></span>
        </label>
      </div>

      {expanded && !hidden && (
        <div className="catprefs-cats">
          {group.rawCategories.map(c => (
            <CategoryRow
              key={c.name}
              c={c}
              baselineExcludedCategories={baselineExcludedCategories}
              onToggleBaselineCategory={onToggleBaselineCategory}
            />
          ))}
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
