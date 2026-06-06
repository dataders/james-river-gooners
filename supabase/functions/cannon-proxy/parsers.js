// Pure Maxanet HTML/cookie parsing helpers.
// No Deno or Node APIs — safe to import in either runtime.
// Tested in src/utils/cannonProxy.parsers.test.js.

export function parseCookies(setCookieHeader) {
  const out = {}
  for (const chunk of setCookieHeader.split(/,(?=[^ ])/)) {
    const pair = chunk.trim().split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

export function mergeCookies(a, b) {
  return { ...a, ...b }
}

export function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

// Extracts all <input type="hidden" name="..." value="..."> from an HTML fragment.
export function parseHiddenInputs(html) {
  const out = {}
  for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const tag = m[0]
    const name = tag.match(/name="([^"]+)"/)?.[1]
    const value = tag.match(/value="([^"]*)"/)?.[1] ?? ''
    if (name) out[name] = value
  }
  return out
}

// Extracts {itemId, auctionId} pairs from Maxanet BidHistory HTML.
// Prefers full AuctionItemDetail URLs (carry both IDs); falls back to any
// AuctionItemId mention (onclick handlers, hidden inputs) for items where
// AuctionId is unavailable.
export function parseBidItems(html) {
  const seen = new Set()
  const out = []

  for (const m of html.matchAll(/(?:href|data-url)="([^"]*?AuctionItemId[^"]+)"/gi)) {
    const raw = m[1].replace(/&amp;/g, '&')
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
    const p = new URLSearchParams(q)
    const itemId = p.get('AuctionItemId')
    if (!itemId || seen.has(itemId)) continue
    seen.add(itemId)
    out.push({ itemId, auctionId: p.get('AuctionId') ?? '' })
  }

  for (const m of html.matchAll(/AuctionItemId[=:]["']?(\d+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push({ itemId: m[1], auctionId: '' })
    }
  }

  return out
}

// Best-effort extraction of the user's bidder number from BidHistory HTML.
// Returns null if none of the known patterns match.
export function parseBidderId(html) {
  const patterns = [
    /bidder\s*#\s*(\d+)/i,
    /bidder\s*number[:\s]+(\d+)/i,
    /BidderNumber[=":\s]+(\d+)/i,
    /data-bidder-id="(\d+)"/i,
    /my\s+bidder\s+(?:id|#)[:\s]+(\d+)/i,
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return null
}

// Extracts {itemId, auctionId} pairs from Maxanet GetWatchlist HTML.
// The GetWatchlist AJAX endpoint returns one item card per bid; each card has
// 4 social-share buttons whose onclick encodes both IDs unambiguously:
//   GetSocialNetworkUrl('/...', 'Facebook', auctionId, auctionItemId)
// Falls back to hidden input fields (item.AuctionId / item.AuctionItemId) if
// the social buttons are absent.
export function parseWatchlistItems(html) {
  const seen = new Set()
  const out = []

  for (const m of html.matchAll(/GetSocialNetworkUrl\s*\([^)]+,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    const auctionId = m[1], itemId = m[2]
    if (!seen.has(itemId)) { seen.add(itemId); out.push({ itemId, auctionId }) }
  }

  if (out.length === 0) {
    let pendingAuctionId = ''
    for (const m of html.matchAll(/<input[^>]+>/gi)) {
      const tag = m[0]
      const nameMatch = tag.match(/name="item\.(AuctionItemId|AuctionId)"/)
      const valueMatch = tag.match(/value="(\d+)"/)
      if (!nameMatch || !valueMatch) continue
      if (nameMatch[1] === 'AuctionId') pendingAuctionId = valueMatch[1]
      else if (nameMatch[1] === 'AuctionItemId' && !seen.has(valueMatch[1])) {
        seen.add(valueMatch[1]); out.push({ itemId: valueMatch[1], auctionId: pendingAuctionId })
      }
    }
  }

  return out
}

// Parses a Maxanet RefreshItem HTML response for live bid state.
// Returns winning (true/false/null), currentBid, and minimumNextBid.
export function parseRefreshItemHtml(html) {
  const cb = html.match(/name="CurrentBidAmount"[^>]*value="([^"]+)"/)?.[1]
  const mnb = html.match(/name="MinimumNextBidAmount"[^>]*value="([^"]+)"/)?.[1]
  const winning = html.includes('<span>Winning :') ? true
    : html.includes('<span>Outbid :') ? false
    : null
  return {
    winning,
    currentBid: cb != null ? parseFloat(cb) : null,
    minimumNextBid: mnb != null ? parseFloat(mnb) : null,
  }
}
