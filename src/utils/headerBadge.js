// @ts-check
// What the mobile hamburger badge shows. Bid alerts (you're being outbid) are
// the most urgent signal, so they win over the What's-new "unseen" dot. Mirrors
// the count formatting AccountButton uses for .bid-alert-badge (9+ clamp).
/**
 * @param {number | undefined} alertCount
 * @param {boolean} hasUnseen
 * @returns {{ kind: 'count' | 'dot' | 'none', value: string }}
 */
export function headerBadge(alertCount, hasUnseen) {
  const raw = alertCount ?? 0
  const count = Number.isFinite(raw) && raw > 0 ? raw : 0
  if (count > 0) return { kind: 'count', value: count > 9 ? '9+' : String(count) }
  if (hasUnseen) return { kind: 'dot', value: '' }
  return { kind: 'none', value: '' }
}
