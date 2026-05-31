export function timeRemaining(endDate) {
  if (!endDate) return ''
  // ISO format (contains 'T') parses correctly as-is; only apply the
  // replace trick for Maxanet's "YYYY-MM-DD H:MM:SS AM/PM" format.
  const end = new Date(endDate.includes('T') ? endDate : endDate.replace(/-/g, '/'))
  const now = new Date()
  const diff = end - now
  if (diff <= 0) return 'Ended'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h`
  const mins = Math.floor((diff % 3600000) / 60000)
  return `${hours}h ${mins}m`
}
