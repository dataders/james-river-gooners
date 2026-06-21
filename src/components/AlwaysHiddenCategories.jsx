// @ts-check

// Compact review/restore list for the user's permanent "always hidden" set.
// Categories get *added* to this set inline in the Filters panel (hide a
// category, then "never show this"); this is just where you see what you've
// hidden and undo it. Deliberately NOT a second category tree — it renders the
// baseline group/category names directly, no grouping or counts needed.

/**
 * @param {{
 *   baselineExcludedGroups: string[],
 *   baselineExcludedCategories: string[],
 *   onRemoveGroup: (g: string) => void,
 *   onRemoveCategory: (c: string) => void,
 *   onClearAll: () => void,
 * }} props
 */
export function AlwaysHiddenCategories({
  baselineExcludedGroups,
  baselineExcludedCategories,
  onRemoveGroup,
  onRemoveCategory,
  onClearAll,
}) {
  const items = [
    ...baselineExcludedGroups.map(name => ({ name, remove: () => onRemoveGroup(name) })),
    ...baselineExcludedCategories.map(name => ({ name, remove: () => onRemoveCategory(name) })),
  ]

  if (items.length === 0) {
    return (
      <p className="always-hidden-empty">
        Nothing hidden yet. Hide a category in Filters, then choose “never show this.”
      </p>
    )
  }

  return (
    <div className="always-hidden-list">
      <div className="filter-chips">
        {items.map(({ name, remove }) => (
          <button
            key={name}
            type="button"
            className="filter-chip hidden"
            onClick={remove}
            title={`Restore ${name}`}
            aria-label={`Restore ${name}`}
          >
            <span className="lock-mark" aria-hidden="true">🔒</span>
            {name}
            <span className="x-mark" aria-hidden="true">✕</span>
          </button>
        ))}
      </div>
      <button type="button" className="filter-action" onClick={onClearAll}>restore all</button>
    </div>
  )
}
