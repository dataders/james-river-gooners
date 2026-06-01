// Shared parsing for auction/item end-date strings.
//
// Two formats appear in the data:
//   - ISO 8601 (HiBid), e.g. "2026-06-06T23:00:00+00:00" — parses natively.
//   - Maxanet/Cannon's "YYYY-MM-DD H:MM:SS AM/PM", e.g. "2026-06-01 9:59:00 PM"
//     — the browser only parses this reliably when the dashes are slashes,
//     which makes it parse as local time (matching how the timer displays).
//
// The `includes('T')` check distinguishes the two: only ISO strings contain a
// 'T' separator, so the slash swap is applied solely to the Maxanet format.
// Applying it to ISO strings would corrupt them into an unparseable value.

export function parseAuctionDate(endDate) {
  if (!endDate) return null
  const d = new Date(endDate.includes('T') ? endDate : endDate.replace(/-/g, '/'))
  return Number.isNaN(d.getTime()) ? null : d
}

// True when the deadline is at or before `now` (ms epoch). Unparseable or
// missing dates are treated as not-yet-passed so we never hide an auction
// just because its date string is malformed.
export function isPastDeadline(endDate, now = Date.now()) {
  const d = parseAuctionDate(endDate)
  return d != null && d.getTime() <= now
}
