import { parseAuctionDate } from './dates.js'

export function timeRemaining(endDate) {
  const end = parseAuctionDate(endDate)
  if (!end) return ''
  const now = new Date()
  const diff = end - now
  if (diff <= 0) return 'Ended'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h`
  const mins = Math.floor((diff % 3600000) / 60000)
  return `${hours}h ${mins}m`
}

// Closed Cannon's lots have no live countdown, so their per-lot `endDate` is
// blank and `timeRemaining` would return '' — leaving the card with no time
// line at all (not even "Ended"). Fall back to the auction-level
// `auctionEndDate`, which the scraper always populates (from the title date for
// closed auctions), so closed lots show "Ended" and active lots still get a
// real countdown.
export function itemTimeRemaining(item) {
  return timeRemaining(item?.endDate || item?.auctionEndDate)
}
