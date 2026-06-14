// @ts-nocheck
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCookies,
  mergeCookies,
  cookieHeader,
  parseHiddenInputs,
  parseBidItems,
  parseBidderId,
  parseRefreshItemHtml,
} from '../../supabase/functions/cannon-proxy/parsers.js'

// ── parseCookies ─────────────────────────────────────────────────────────────

test('parseCookies extracts a single cookie', () => {
  assert.deepEqual(
    parseCookies('ASP.NET_SessionId=abc123; path=/; HttpOnly'),
    { 'ASP.NET_SessionId': 'abc123' },
  )
})

test('parseCookies splits multiple cookies separated by comma-nonspace', () => {
  // Fetch API joins multiple Set-Cookie headers with ", " when the next cookie
  // name starts with a non-space character immediately after the comma.
  const header = 'ASP.NET_SessionId=abc; path=/; HttpOnly,.ASPXAUTH=xyz; path=/; secure'
  assert.deepEqual(parseCookies(header), {
    'ASP.NET_SessionId': 'abc',
    '.ASPXAUTH': 'xyz',
  })
})

test('parseCookies preserves commas inside Expires dates (space after comma)', () => {
  // "Thu, 01 Jan" — comma is followed by a space, so it must NOT split there
  const header = 'auth=tok; Expires=Thu, 01 Jan 2026 00:00:00 GMT; path=/'
  assert.deepEqual(parseCookies(header), { auth: 'tok' })
})

test('parseCookies returns empty object for empty string', () => {
  assert.deepEqual(parseCookies(''), {})
})

test('parseCookies does not split on comma-space separator (known limitation)', () => {
  // headers.get('set-cookie') joins multiple Set-Cookie headers with ', ' (comma-space).
  // parseCookies only splits on ',(?=[^ ])' so a comma-space boundary is NOT recognized —
  // only the first cookie survives. This is why the edge function uses getSetCookie()
  // (returns the full array) instead of headers.get('set-cookie').
  const joined = 'ASP.NET_SessionId=abc; path=/; HttpOnly, .AspNet.Cookies=tok; path=/; Secure'
  const result = parseCookies(joined)
  assert.equal(result['ASP.NET_SessionId'], 'abc')
  assert.equal(result['.AspNet.Cookies'], undefined) // silently dropped
})

test('parseCookies handles cookie value containing equals sign', () => {
  // Base64 values may contain trailing "="
  const header = 'token=abc==; path=/'
  const result = parseCookies(header)
  assert.equal(result.token, 'abc==')
})

// ── mergeCookies / cookieHeader ───────────────────────────────────────────────

test('mergeCookies unions two cookie maps, with b overriding a', () => {
  const a = { session: 'old', foo: 'bar' }
  const b = { session: 'new', baz: 'qux' }
  assert.deepEqual(mergeCookies(a, b), { session: 'new', foo: 'bar', baz: 'qux' })
})

test('cookieHeader serializes cookies to key=value pairs joined by semicolons', () => {
  const cookies = { 'ASP.NET_SessionId': 'abc123', '.ASPXAUTH': 'xyz' }
  const header = cookieHeader(cookies)
  assert.ok(header.includes('ASP.NET_SessionId=abc123'))
  assert.ok(header.includes('.ASPXAUTH=xyz'))
  assert.ok(header.includes('; '))
})

// ── parseHiddenInputs ─────────────────────────────────────────────────────────

test('parseHiddenInputs extracts name/value from a standard hidden input', () => {
  const html = '<input type="hidden" name="__RequestVerificationToken" value="CfDJ8xYZ" />'
  assert.deepEqual(parseHiddenInputs(html), { '__RequestVerificationToken': 'CfDJ8xYZ' })
})

test('parseHiddenInputs handles attributes in any order', () => {
  const html = '<input name="UserId" type="hidden" value="4521" />'
  assert.deepEqual(parseHiddenInputs(html), { UserId: '4521' })
})

test('parseHiddenInputs is case-insensitive on type="hidden"', () => {
  const html = '<INPUT TYPE="HIDDEN" name="TenantId" value="399">'
  assert.deepEqual(parseHiddenInputs(html), { TenantId: '399' })
})

test('parseHiddenInputs extracts multiple fields from a form fragment', () => {
  const html = `
    <input type="hidden" name="__RequestVerificationToken" value="CfDJ8abc" />
    <input type="hidden" name="UserId" value="456" />
    <input type="hidden" name="TenantId" value="399" />
    <input type="hidden" name="ReservePriceAmount" value="0" />
  `
  const fields = parseHiddenInputs(html)
  assert.equal(fields['__RequestVerificationToken'], 'CfDJ8abc')
  assert.equal(fields.UserId, '456')
  assert.equal(fields.TenantId, '399')
  assert.equal(fields.ReservePriceAmount, '0')
})

test('parseHiddenInputs treats a missing value attribute as empty string', () => {
  const html = '<input type="hidden" name="ReturnUrl" value="" />'
  assert.deepEqual(parseHiddenInputs(html), { ReturnUrl: '' })
})

test('parseHiddenInputs ignores non-hidden inputs', () => {
  const html = `
    <input type="text" name="Username" value="me" />
    <input type="hidden" name="TenantCode" value="Can399" />
    <input type="submit" value="Login" />
  `
  assert.deepEqual(parseHiddenInputs(html), { TenantCode: 'Can399' })
})

// ── parseBidItems ─────────────────────────────────────────────────────────────

test('parseBidItems extracts itemId and auctionId from href with query params', () => {
  const html = `<a href="/Public/Auction/AuctionItemDetail?AuctionItemId=48521&AuctionId=2847">Lot 42</a>`
  assert.deepEqual(parseBidItems(html), [{ itemId: '48521', auctionId: '2847' }])
})

test('parseBidItems decodes HTML-encoded ampersands in hrefs', () => {
  const html = `<a href="/Public/Auction/AuctionItemDetail?AuctionItemId=48521&amp;AuctionId=2847">Lot 42</a>`
  assert.deepEqual(parseBidItems(html), [{ itemId: '48521', auctionId: '2847' }])
})

test('parseBidItems deduplicates repeated links to the same item', () => {
  const html = `
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=100&AuctionId=5">Item</a>
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=100&AuctionId=5">Item again</a>
  `
  const items = parseBidItems(html)
  assert.equal(items.length, 1)
  assert.equal(items[0].itemId, '100')
})

test('parseBidItems handles multiple distinct items preserving order', () => {
  const html = `
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=111&AuctionId=9">A</a>
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=222&AuctionId=9">B</a>
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=333&AuctionId=9">C</a>
  `
  const items = parseBidItems(html)
  assert.deepEqual(items.map(i => i.itemId), ['111', '222', '333'])
  assert.ok(items.every(i => i.auctionId === '9'))
})

test('parseBidItems also matches data-url attributes', () => {
  const html = `<div data-url="/Public/Auction/AuctionItemDetail?AuctionItemId=777&AuctionId=3"></div>`
  assert.deepEqual(parseBidItems(html), [{ itemId: '777', auctionId: '3' }])
})

test('parseBidItems falls back to inline AuctionItemId mentions with no auctionId', () => {
  // onclick handlers, hidden inputs — no AuctionId available
  const html = `<button onclick="bid(AuctionItemId=9999)">Bid</button>`
  assert.deepEqual(parseBidItems(html), [{ itemId: '9999', auctionId: '' }])
})

test('parseBidItems prefers href result over fallback for same itemId', () => {
  // href is seen first and populates the dedup set; the fallback mention is skipped
  const html = `
    <a href="/Public/Auction/AuctionItemDetail?AuctionItemId=500&AuctionId=8">Item</a>
    <input type="hidden" name="AuctionItemId" value="500" />
  `
  const items = parseBidItems(html)
  assert.equal(items.length, 1)
  assert.equal(items[0].auctionId, '8')
})

test('parseBidItems returns empty array for HTML with no auction item references', () => {
  assert.deepEqual(parseBidItems('<p>No bids yet</p>'), [])
})

// ── parseBidderId ────────────────────────────────────────────────────────────

test('parseBidderId matches "Bidder # N" pattern', () => {
  assert.equal(parseBidderId('<p>Bidder # 1042</p>'), '1042')
})

test('parseBidderId matches "Bidder Number: N" pattern', () => {
  assert.equal(parseBidderId('<span>Bidder Number: 7</span>'), '7')
})

test('parseBidderId matches data-bidder-id attribute', () => {
  assert.equal(parseBidderId('<div data-bidder-id="999"></div>'), '999')
})

test('parseBidderId matches "My Bidder ID: N" pattern', () => {
  assert.equal(parseBidderId('My Bidder ID: 42'), '42')
})

test('parseBidderId is case-insensitive', () => {
  assert.equal(parseBidderId('BIDDER # 55'), '55')
})

test('parseBidderId returns null when no known pattern is present', () => {
  assert.equal(parseBidderId('<p>You have no bids</p>'), null)
})

// ── parseRefreshItemHtml ──────────────────────────────────────────────────────
// Fixtures are simplified versions of what Maxanet's RefreshItem endpoint
// returns — confirmed via HAR capture.

const WINNING_HTML = `
  <input type="hidden" name="CurrentBidAmount" value="125.00" />
  <input type="hidden" name="MinimumNextBidAmount" value="130.00" />
  <span>Winning : $125.00</span>
  <span class="bid-amount">Current bid: $125.00</span>
`

const OUTBID_HTML = `
  <input type="hidden" name="CurrentBidAmount" value="150.00" />
  <input type="hidden" name="MinimumNextBidAmount" value="160.00" />
  <span>Outbid : $150.00</span>
`

const NO_STATUS_HTML = `
  <input type="hidden" name="CurrentBidAmount" value="75.00" />
  <input type="hidden" name="MinimumNextBidAmount" value="80.00" />
  <p>Auction ended</p>
`

test('parseRefreshItemHtml detects winning status', () => {
  const result = parseRefreshItemHtml(WINNING_HTML)
  assert.equal(result.winning, true)
})

test('parseRefreshItemHtml detects outbid status', () => {
  const result = parseRefreshItemHtml(OUTBID_HTML)
  assert.equal(result.winning, false)
})

test('parseRefreshItemHtml returns null winning when status label is absent', () => {
  assert.equal(parseRefreshItemHtml(NO_STATUS_HTML).winning, null)
})

test('parseRefreshItemHtml parses currentBid from hidden input', () => {
  assert.equal(parseRefreshItemHtml(WINNING_HTML).currentBid, 125)
  assert.equal(parseRefreshItemHtml(OUTBID_HTML).currentBid, 150)
})

test('parseRefreshItemHtml parses minimumNextBid from hidden input', () => {
  assert.equal(parseRefreshItemHtml(WINNING_HTML).minimumNextBid, 130)
  assert.equal(parseRefreshItemHtml(OUTBID_HTML).minimumNextBid, 160)
})

test('parseRefreshItemHtml returns null amounts when hidden inputs are missing', () => {
  const html = '<span>Winning : $0.00</span>'
  const result = parseRefreshItemHtml(html)
  assert.equal(result.winning, true)
  assert.equal(result.currentBid, null)
  assert.equal(result.minimumNextBid, null)
})

test('parseRefreshItemHtml handles integer bid amounts without decimals', () => {
  const html = `
    <input type="hidden" name="CurrentBidAmount" value="200" />
    <input type="hidden" name="MinimumNextBidAmount" value="210" />
    <span>Winning : $200</span>
  `
  const result = parseRefreshItemHtml(html)
  assert.equal(result.currentBid, 200)
  assert.equal(result.minimumNextBid, 210)
})

test('parseRefreshItemHtml prefers first CurrentBidAmount hidden input when multiple exist', () => {
  const html = `
    <input type="hidden" name="CurrentBidAmount" value="100.00" />
    <input type="hidden" name="CurrentBidAmount" value="999.00" />
    <span>Outbid : $100.00</span>
  `
  assert.equal(parseRefreshItemHtml(html).currentBid, 100)
})