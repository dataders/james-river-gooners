// Sorting for the item grid. `key` values are stable identifiers persisted in
// URL/localStorage state, so don't rename them without a migration.

export const SORT_OPTIONS = [
  { key: '', label: 'Featured' },
  { key: 'ending', label: 'Ending soonest' },
  { key: 'endingLast', label: 'Ending latest' },
  { key: 'priceAsc', label: 'Price: low to high' },
  { key: 'priceDesc', label: 'Price: high to low' },
  { key: 'bids', label: 'Most bids' },
]

// Hours until an item ends. Mirrors filters.js so sort and the time filter agree.
// Items with no end date sort to the very end of time-based orderings.
function hoursUntil(endDate) {
  if (!endDate) return Infinity
  const end = new Date(endDate.replace(/-/g, '/'))
  const h = (end.getTime() - Date.now()) / 3_600_000
  return Number.isNaN(h) ? Infinity : h
}

const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0)

/**
 * Return a new array of `items` ordered by `sortKey`. An empty/unknown key
 * leaves the original order untouched (and returns the original reference).
 */
export function sortItems(items, sortKey) {
  if (!sortKey) return items
  const arr = [...items]
  switch (sortKey) {
    case 'ending':
      // Soonest-ending first; dateless lots (Infinity) fall to the bottom.
      return arr.sort((a, b) => hoursUntil(a.endDate) - hoursUntil(b.endDate))
    case 'endingLast':
      // Latest-ending first; dateless lots still sort last.
      return arr.sort((a, b) => {
        const ha = hoursUntil(a.endDate)
        const hb = hoursUntil(b.endDate)
        if (ha === Infinity) return 1
        if (hb === Infinity) return -1
        return hb - ha
      })
    case 'priceAsc':
      return arr.sort((a, b) => num(a.currentBid) - num(b.currentBid))
    case 'priceDesc':
      return arr.sort((a, b) => num(b.currentBid) - num(a.currentBid))
    case 'bids':
      return arr.sort((a, b) => num(b.totalBids) - num(a.totalBids))
    default:
      return items
  }
}
