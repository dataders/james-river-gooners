// @ts-nocheck
import { parseAuctionDate } from './dates.js'

// Compact "Jun 11, 7:56 PM" in the viewer's local timezone — consistent with
// the live countdown, which also displays local time (see dates.js).
function formatEndedAt(end) {
  const date = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date}, ${time}`
}

export function timeRemaining(endDate) {
  const end = parseAuctionDate(endDate)
  if (!end) return ''
  const now = new Date()
  const diff = end - now
  // Stamp closed lots with *when* they ended. Sources like HiBid stagger lot
  // close times across days, so a lot can read "Ended" while its parent auction
  // is still live — the date makes that visible at a glance.
  if (diff <= 0) return `Ended ${formatEndedAt(end)}`
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

// Whether a lot's bidding window has closed. A missing/unparseable date is
// treated as ended (no live deadline to bid against). Kept separate from the
// display string so callers don't depend on the exact "Ended …" wording.
export function itemEnded(item) {
  const end = parseAuctionDate(item?.endDate || item?.auctionEndDate)
  return end == null || end.getTime() <= Date.now()
}