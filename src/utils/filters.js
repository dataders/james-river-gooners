function hoursUntil(endDate) {
  if (!endDate) return Infinity
  const end = new Date(endDate.replace(/-/g, '/'))
  return Math.max(0, (end - new Date()) / 3600000)
}

/**
 * Filter auction items based on preferences.
 * excludedCategories now contains rawCategory values.
 */
export function filterItems(items, { excludedCategories, searchQuery, minPrice, maxPrice, minBids, maxBids, minHours, maxHours }) {
  return items.filter(item => {
    // Exclude filter: hide items by rawCategory
    if (excludedCategories.includes(item.rawCategory)) {
      return false
    }

    // Price filter
    if (minPrice != null && item.currentBid < minPrice) {
      return false
    }
    if (maxPrice != null && item.currentBid > maxPrice) {
      return false
    }

    // Bids filter
    if (minBids != null && item.totalBids < minBids) {
      return false
    }
    if (maxBids != null && item.totalBids > maxBids) {
      return false
    }

    // Time filter
    if (minHours != null || maxHours != null) {
      const h = hoursUntil(item.endDate)
      if (minHours != null && h < minHours) return false
      if (maxHours != null && h > maxHours) return false
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
 * Get raw categories grouped under their normalized group, with counts.
 * Returns: [{ group: "Electronics", rawCategories: [{ name: "Audiovisual", count: 22 }, ...] }, ...]
 */
export function getGroupedCategories(items) {
  // Count raw categories
  const rawCounts = {}
  const rawToGroup = {}
  for (const item of items) {
    const raw = item.rawCategory || 'Other'
    rawCounts[raw] = (rawCounts[raw] || 0) + 1
    if (!rawToGroup[raw]) {
      rawToGroup[raw] = item.category || 'Other'
    }
  }

  // Group by normalized category
  const groups = {}
  for (const [raw, count] of Object.entries(rawCounts)) {
    const group = rawToGroup[raw]
    if (!groups[group]) {
      groups[group] = { group, rawCategories: [], totalCount: 0 }
    }
    groups[group].rawCategories.push({ name: raw, count })
    groups[group].totalCount += count
  }

  // Sort groups by total count, sort raw categories within each group
  return Object.values(groups)
    .sort((a, b) => b.totalCount - a.totalCount)
    .map(g => ({
      ...g,
      rawCategories: g.rawCategories.sort((a, b) => b.count - a.count),
    }))
}
