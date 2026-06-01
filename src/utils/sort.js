// Sorting for the item grid. `key` values are stable identifiers persisted in
// URL/localStorage state, so don't rename them without a migration.

import { parseAuctionDate } from './dates.js'

export const SORT_OPTIONS = [
  { key: '', label: 'Featured' },
  { key: 'ending', label: 'Ending soonest' },
  { key: 'endingLast', label: 'Ending latest' },
  { key: 'priceAsc', label: 'Price: low to high' },
  { key: 'priceDesc', label: 'Price: high to low' },
  { key: 'bids', label: 'Most bids' },
]

// Hours until an item ends. Delegates date parsing to the shared
// parseAuctionDate so both auction formats are handled — Maxanet
// "YYYY-MM-DD h:mm:ss AM/PM" and HiBid ISO 8601 ("...T...+00:00"). A naive
// dash→slash swap would corrupt the ISO form and send every HiBid lot to the
// bottom of time-based orderings. Items with no/unparseable date sort last.
function hoursUntil(endDate) {
  const end = parseAuctionDate(endDate)
  if (!end) return Infinity
  return (end.getTime() - Date.now()) / 3_600_000
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
