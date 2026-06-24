// @ts-check
// Shared parsing for auction/item end-date strings.
//
// Two formats appear in the data:
//   - ISO 8601 (HiBid), e.g. "2026-06-06T23:00:00+00:00" — parses natively.
//   - Maxanet/Cannon's/Rasmus naive "YYYY-MM-DD H:MM:SS AM/PM", e.g. "2026-06-01 9:59:00 PM"
//     — no timezone marker, but these times are always US Eastern (America/New_York).
//     We parse the components and apply the America/New_York offset via Intl to
//     get the correct UTC instant (handles EST ↔ EDT automatically).
//
// The `includes('T')` check distinguishes the two: only ISO strings contain a
// 'T' separator, so the naive path is applied solely to the Maxanet format.

/**
 * @param {string | null | undefined} endDate
 * @returns {Date | null}
 */
export function parseAuctionDate(endDate) {
  if (!endDate) return null
  if (endDate.includes('T')) {
    // ISO 8601 (HiBid): explicit offset, parses natively.
    const d = new Date(endDate)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // Maxanet/Cannon's/Rasmus naive format: "YYYY-MM-DD H:MM:SS AM/PM" in US Eastern.
  const m = endDate.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d+):(\d+):(\d+)\s*(AM|PM)$/i)
  if (!m) return null
  const [, yr, mo, da, hr, mn, sc, ampm] = m
  let h = parseInt(hr, 10)
  if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12
  else if (ampm.toUpperCase() === 'AM' && h === 12) h = 0
  // Step 1: treat the local components as if they were UTC (first approximation).
  const approx = new Date(Date.UTC(Number(yr), Number(mo) - 1, Number(da), h, Number(mn), Number(sc)))
  // Step 2: ask Intl what Eastern time those UTC ms represent.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(approx).map(p => [p.type, p.value])
  )
  // Step 3: measure the UTC↔ET offset; shift by it to get the true UTC instant.
  // The `% 24` guards against engines that return hour='24' for midnight.
  const etH = Number(parts.hour) % 24
  const etAsUtc = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), etH, Number(parts.minute), Number(parts.second)))
  return new Date(approx.getTime() + (approx.getTime() - etAsUtc.getTime()))
}

// True when the deadline is at or before `now` (ms epoch). Unparseable or
// missing dates are treated as not-yet-passed so we never hide an auction
// just because its date string is malformed.
/**
 * @param {string | null | undefined} endDate
 * @param {number} [now] ms epoch
 * @returns {boolean}
 */
export function isPastDeadline(endDate, now = Date.now()) {
  const d = parseAuctionDate(endDate)
  return d != null && d.getTime() <= now
}
