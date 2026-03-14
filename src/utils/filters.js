/**
 * Filter auction items based on preferences.
 */
export function filterItems(items, { includedCategories, excludedCategories, searchQuery }) {
  return items.filter(item => {
    // Include filter: if specific categories are selected, only show those
    if (includedCategories.length > 0 && !includedCategories.includes(item.category)) {
      return false
    }

    // Exclude filter: hide items in excluded categories
    if (excludedCategories.includes(item.category)) {
      return false
    }

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      const searchable = `${item.title} ${item.description} ${item.rawCategory}`.toLowerCase()
      if (!searchable.includes(q)) {
        return false
      }
    }

    return true
  })
}

/**
 * Get unique category groups from items with counts.
 */
export function getCategoryCounts(items) {
  const counts = {}
  for (const item of items) {
    counts[item.category] = (counts[item.category] || 0) + 1
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }))
}
