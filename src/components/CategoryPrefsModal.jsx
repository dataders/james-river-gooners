// @ts-check
import { useEffect, useRef, useState } from 'react'

/**
 * @param {{ name: string, count: number }} c
 * @param {{ baselineExcludedCategories: string[], onToggleBaselineCategory: (cat: string) => void }} props
 */
function CategoryRow({ c, baselineExcludedCategories, onToggleBaselineCategory }) {
  const hidden = baselineExcludedCategories.includes(c.name)
  return (
    <label className="catprefs-cat-row">
      <input
        type="checkbox"
        className="catprefs-checkbox"
        checked={hidden}
        onChange={() => onToggleBaselineCategory(c.name)}
      />
      <span className={`catprefs-cat-name${hidden ? ' catprefs-cat-name--hidden' : ''}`}>
        {c.name}
      </span>
      <span className="catprefs-cat-count">{c.count}</span>
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
        <label className="catprefs-group-toggle" title={hidden ? 'Always hidden — click to show' : 'Always shown — click to hide'}>
          <span className="catprefs-toggle-label">{hidden ? 'Always hidden' : 'Visible'}</span>
          <input
            type="checkbox"
            className="catprefs-checkbox"
            checked={hidden}
            onChange={() => onToggleBaselineGroup(group.group)}
          />
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
 *   onClose: () => void,
 * }} props
 */
export function CategoryPrefsModal({
  groupedCategories,
  baselineExcludedGroups,
  baselineExcludedCategories,
  onToggleBaselineGroup,
  onToggleBaselineCategory,
  onClose,
}) {
  const overlayRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()
    /** @param {KeyboardEvent} e */
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  /** @param {MouseEvent} e */
  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose()
  }

  const hiddenGroupCount = groupedCategories.filter(g => baselineExcludedGroups.includes(g.group)).length

  return (
    <div
      className="tutorial-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="Category preferences"
    >
      <div className="tutorial-panel catprefs-panel">
        <div className="tutorial-header">
          <h2 className="tutorial-title">Category preferences</h2>
          <button
            className="tutorial-close"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close category preferences"
          >✕</button>
        </div>

        <p className="catprefs-description">
          Categories marked <strong>Always hidden</strong> are excluded by default.
          &ldquo;Clear filters&rdquo; always restores this list — you can still
          temporarily show a category from the filter panel without changing these settings.
        </p>

        {hiddenGroupCount > 0 && (
          <p className="catprefs-hint">
            {hiddenGroupCount} group{hiddenGroupCount > 1 ? 's' : ''} always hidden &mdash; their items are also excluded from your For&nbsp;You rankings.
          </p>
        )}

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
      </div>
    </div>
  )
}
