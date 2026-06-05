// Cannon's/Maxanet proxy — Supabase Edge Function
//
// Actions (POST body JSON):
//   save_credentials  { username, password }  → store encrypted credentials
//   delete_credentials                         → remove credentials
//   get_status                                 → { linked, username }
//   get_bids                                   → { itemIds: string[] }
//   place_bid         { auctionItemId, auctionId, newBidAmount, maxBidAmount,
//                       currentBid, minimumNextBid, itemName?, endDate?,
//                       totalBids?, category?, skuNumber? }
//                     → { ok, status, description }
//
// Env vars required:
//   SUPABASE_URL               (auto-injected by Supabase)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-injected by Supabase)
//   CANNON_ENCRYPTION_KEY      (set in Edge Function secrets — any 32+ char string)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function getKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(rawKey.padEnd(32, '0').slice(0, 32))
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptText(plaintext: string): Promise<string> {
  const key = await getKey(Deno.env.get('CANNON_ENCRYPTION_KEY') ?? '')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(12 + encrypted.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(encrypted), 12)
  return btoa(String.fromCharCode(...combined))
}

async function decryptText(ciphertext: string): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0))
  const key = await getKey(Deno.env.get('CANNON_ENCRYPTION_KEY') ?? '')
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  )
  return new TextDecoder().decode(decrypted)
}

// ── Maxanet helpers ───────────────────────────────────────────────────────────

function parseCookies(setCookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const chunk of setCookieHeader.split(/,(?=[^ ])/)) {
    const pair = chunk.trim().split(';')[0]
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

function mergeCookies(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  return { ...a, ...b }
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

// Extracts all <input type="hidden" name="..." value="..."> from an HTML fragment.
function parseHiddenInputs(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const tag = m[0]
    const name = tag.match(/name="([^"]+)"/)?.[1]
    const value = tag.match(/value="([^"]*)"/)?.[1] ?? ''
    if (name) out[name] = value
  }
  return out
}

async function maxanetLogin(username: string, password: string): Promise<Record<string, string>> {
  const base = 'https://bid.cannonsauctions.com'

  // Step 1 — fetch login page for anti-forgery token + initial cookies
  const pageResp = await fetch(`${base}/Public/Account/Login`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  })
  if (!pageResp.ok) throw new Error(`Login page returned ${pageResp.status}`)

  const pageHtml = await pageResp.text()
  const cookies = parseCookies(pageResp.headers.get('set-cookie') ?? '')

  const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  const verificationToken = tokenMatch?.[1] ?? ''

  // TenantCode is a hidden field required by Maxanet (Cannon's value is "Can399")
  const tenantMatch = pageHtml.match(/name="TenantCode"[^>]*value="([^"]+)"/)
  const tenantCode = tenantMatch?.[1] ?? ''

  // Step 2 — POST credentials to the actual login handler (different from the page URL)
  const loginResp = await fetch(`${base}/Public/Login/Login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'Referer': `${base}/Public/Account/Login`,
    },
    body: new URLSearchParams({
      ReturnUrl: '',
      TenantCode: tenantCode,
      Username: username,
      Password: password,
      __RequestVerificationToken: verificationToken,
    }).toString(),
    redirect: 'manual',
  })

  // Successful login → 302 redirect away from /Account/Login
  // Failed login → 200 (re-renders the form with an error message)
  if (loginResp.status === 200) {
    const body = await loginResp.text()
    const errMatch = body.match(/class="[^"]*validation-summary[^"]*"[^>]*>([\s\S]{0,300}?)<\//)
    throw new Error(errMatch ? `Login failed: ${errMatch[1].replace(/<[^>]+>/g, '').trim()}` : 'Login failed')
  }
  if (loginResp.status !== 302) throw new Error(`Unexpected login response: ${loginResp.status}`)

  const sessionCookies = mergeCookies(cookies, parseCookies(loginResp.headers.get('set-cookie') ?? ''))
  return sessionCookies
}

interface BidItem {
  itemId: string
  auctionId: string
}

interface BidStatus {
  auctionItemId: string
  winning: boolean | null
  currentBid: number | null
  minimumNextBid: number | null
}

// Parses bid history HTML into item+auction ID pairs.
// Prefers full AuctionItemDetail URLs (which carry both IDs); falls back to
// any AuctionItemId mention for items where AuctionId isn't available.
function parseBidItems(html: string): BidItem[] {
  const seen = new Set<string>()
  const out: BidItem[] = []

  // href/data-url attributes containing AuctionItemId query params
  for (const m of html.matchAll(/(?:href|data-url)="([^"]*?AuctionItemId[^"]+)"/gi)) {
    const raw = m[1].replace(/&amp;/g, '&')
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
    const p = new URLSearchParams(q)
    const itemId = p.get('AuctionItemId')
    if (!itemId || seen.has(itemId)) continue
    seen.add(itemId)
    out.push({ itemId, auctionId: p.get('AuctionId') ?? '' })
  }

  // Fallback: plain AuctionItemId mentions (onclick handlers, hidden inputs)
  for (const m of html.matchAll(/AuctionItemId[=:]["']?(\d+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push({ itemId: m[1], auctionId: '' })
    }
  }

  return out
}

function parseBidderId(html: string): string | null {
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

// Calls RefreshItem for a single bid and parses winning/outbid status from
// the rendered HTML. Non-fatal — returns null fields on any failure.
async function refreshItemStatus(
  base: string,
  cookies: Record<string, string>,
  csrf: string,
  { itemId, auctionId }: BidItem,
): Promise<BidStatus> {
  try {
    const resp = await fetch(`${base}/Public/Auction/RefreshItem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(cookies),
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        __RequestVerificationToken: csrf,
        model: JSON.stringify({
          AuctionId: auctionId ? Number(auctionId) : 0,
          AuctionItemId: Number(itemId),
          TenantId: 399,
          IsBiddingEnabled: true,
          DisplayFormatCode: 'OB',
          StatusCode: 'NW',
        }),
        index: '1',
        viewType: '2',
        auctionItemFilterVM: JSON.stringify({
          AuctionId: auctionId || '0',
          AuctionItemId: Number(itemId),
          pageNumber: '1',
          itemsPerPage: 1,
          viewType: '2',
          Filter: 'Current',
          __RequestVerificationToken: csrf,
        }),
      }).toString(),
    })
    const html = await resp.text()
    const cb = html.match(/name="CurrentBidAmount"[^>]*value="([^"]+)"/)?.[1]
    const mnb = html.match(/name="MinimumNextBidAmount"[^>]*value="([^"]+)"/)?.[1]
    const winning = html.includes('<span>Winning :') ? true
      : html.includes('<span>Outbid :') ? false
      : null
    return {
      auctionItemId: itemId,
      winning,
      currentBid: cb ? parseFloat(cb) : null,
      minimumNextBid: mnb ? parseFloat(mnb) : null,
    }
  } catch {
    return { auctionItemId: itemId, winning: null, currentBid: null, minimumNextBid: null }
  }
}

async function fetchBidHistory(cookies: Record<string, string>): Promise<{ itemIds: string[]; items: BidItem[]; csrf: string; bidderId: string | null }> {
  const base = 'https://bid.cannonsauctions.com'

  const resp = await fetch(`${base}/Public/Account/BidHistory`, {
    headers: {
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    redirect: 'manual',
  })

  if (resp.status === 302) throw new Error('Session expired or not logged in (got redirect on BidHistory)')
  if (!resp.ok) throw new Error(`BidHistory returned ${resp.status} — endpoint may need updating`)

  const html = await resp.text()
  const items = parseBidItems(html)
  const csrf = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] ?? ''
  return { itemIds: items.map(b => b.itemId), items, csrf, bidderId: parseBidderId(html) }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function saveCredentials(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  username: string,
  password: string,
): Promise<Response> {
  const enc = await encryptText(password)
  const { error } = await supabase
    .from('cannon_credentials')
    .upsert({ user_id: userId, cannon_username: username, cannon_password_enc: enc, updated_at: new Date().toISOString() })
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function deleteCredentials(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { error } = await supabase.from('cannon_credentials').delete().eq('user_id', userId)
  if (error) return json({ error: error.message }, 500)
  return json({ ok: true })
}

async function getStatus(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from('cannon_credentials')
    .select('cannon_username')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return json({ error: error.message }, 500)
  return json({ linked: !!data, username: data?.cannon_username ?? null })
}

async function getBids(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) return json({ error: error.message }, 500)
  if (!data) return json({ error: 'No Cannon\'s account linked' }, 400)

  let password: string
  try {
    password = await decryptText(data.cannon_password_enc)
  } catch {
    return json({ error: 'Failed to decrypt stored credentials' }, 500)
  }

  let cookies: Record<string, string>
  try {
    cookies = await maxanetLogin(data.cannon_username, password)
  } catch (e: unknown) {
    return json({ error: `Cannon's login failed: ${(e as Error).message}` }, 400)
  }

  let history: { itemIds: string[]; items: BidItem[]; csrf: string; bidderId: string | null }
  try {
    history = await fetchBidHistory(cookies)
  } catch (e: unknown) {
    return json({ error: `Bid history fetch failed: ${(e as Error).message}` }, 400)
  }

  // Auto-populate cannon_bidder_id the first time we see it in a response.
  if (history.bidderId) {
    await supabase
      .from('users')
      .update({ cannon_bidder_id: history.bidderId })
      .eq('id', userId)
      .is('cannon_bidder_id', null)
  }

  const base = 'https://bid.cannonsauctions.com'
  // Cap at 20 items so we don't flood Maxanet with concurrent requests
  const toRefresh = history.items.slice(0, 20)
  const statuses: BidStatus[] = await Promise.all(
    toRefresh.map(item => refreshItemStatus(base, cookies, history.csrf, item))
  )

  return json({ itemIds: history.itemIds, statuses })
}

interface PlaceBidParams {
  auctionItemId: string
  auctionId: string
  newBidAmount: number
  maxBidAmount: number
  currentBid: number
  minimumNextBid: number
  itemName?: string
  endDate?: string
  totalBids?: number
  category?: string
  skuNumber?: string
}

async function placeBid(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  params: PlaceBidParams,
): Promise<Response> {
  const { data, error } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) return json({ error: error.message }, 500)
  if (!data) return json({ error: 'No Cannon\'s account linked' }, 400)

  let password: string
  try {
    password = await decryptText(data.cannon_password_enc)
  } catch {
    return json({ error: 'Failed to decrypt stored credentials' }, 500)
  }

  let cookies: Record<string, string>
  try {
    cookies = await maxanetLogin(data.cannon_username, password)
  } catch (e: unknown) {
    return json({ error: `Cannon's login failed: ${(e as Error).message}` }, 400)
  }

  const base = 'https://bid.cannonsauctions.com'

  // Fetch the item page to get a fresh CSRF token for this session
  const itemPageResp = await fetch(
    `${base}/Public/Auction/AuctionItemDetail?AuctionItemId=${params.auctionItemId}&AuctionId=${params.auctionId}`,
    { headers: { Cookie: cookieHeader(cookies), 'User-Agent': UA }, redirect: 'manual' },
  )
  if (itemPageResp.status === 302) return json({ error: 'Session expired fetching item page' }, 400)
  const itemHtml = await itemPageResp.text()
  cookies = mergeCookies(cookies, parseCookies(itemPageResp.headers.get('set-cookie') ?? ''))
  const itemCsrf = itemHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] ?? ''

  // POST SubmitBid — Maxanet uses this to render the bid confirmation modal.
  // The response HTML contains a pre-populated form with hidden fields we need
  // for SaveBid (notably UserId, TenantId, and a fresh CSRF token).
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const submitResp = await fetch(`${base}/Public/Auction/SubmitBid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      AuctionItemId: params.auctionItemId,
      OldBidAmount: String(params.currentBid),
      NewBidAmount: '0',
      MaxBidAmount: '0',
      Quantity: '1',
      ItemName: params.itemName ?? '',
      __RequestVerificationToken: itemCsrf,
      TotalTerms: '0',
      MinimumNextBidAmount: String(params.minimumNextBid),
      TotalBids: String(params.totalBids ?? 0),
      IsWatchList: 'False',
      DisplayFormatCode: 'OB',
      Types: params.category ?? '',
      SKUNumber: String(params.skuNumber ?? ''),
      Description: '',
      EndDate: params.endDate ?? '',
      StatusCode: 'NW',
      CurrentDate: now,
      IsAutoExtended: 'False',
      IsBiddingEnabled: 'True',
      ReservePrice: '0',
      BidAmount: String(params.currentBid),
      BidNowLabel: 'Bid Now',
      index: '1',
      ImageURL: '',
      OriginalName: '',
      ButtonId: 'bidpopup_1',
      ActivityModuleId: 'PBAUCITM',
    }).toString(),
  })
  cookies = mergeCookies(cookies, parseCookies(submitResp.headers.get('set-cookie') ?? ''))
  const submitHtml = await submitResp.text()

  // The confirmation form has a fresh CSRF token plus UserId, TenantId, etc.
  const formFields = parseHiddenInputs(submitHtml)
  const bidCsrf = formFields.__RequestVerificationToken ?? itemCsrf

  // Accept T&C for this auction — idempotent, required on first bid per auction.
  // Fire-and-forget: don't block the bid if this fails.
  fetch(`${base}/Public/Auction/SaveBidderTermsAndCondition`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      AuctionId: params.auctionId,
      __RequestVerificationToken: bidCsrf,
    }).toString(),
  }).catch(() => {})

  // POST SaveBid — places the actual bid
  const saveBidResp = await fetch(`${base}/Public/Auction/SaveBid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      __RequestVerificationToken: bidCsrf,
      AuctionId: params.auctionId,
      ActivityModuleId: 'PBAUCITM',
      NewBidAmount: String(params.newBidAmount),
      MaxBidAmount: String(params.maxBidAmount),
      minumumNextBixAmount: String(params.minimumNextBid),
      AuctionItemId: params.auctionItemId,
      OldBidAmount: String(params.currentBid),
      ReservePriceAmount: formFields.ReservePriceAmount ?? '0',
      TenantId: formFields.TenantId ?? '399',
      UserId: formFields.UserId ?? '',
      TotalTerms: '0',
      RequestUrl: '',
    }).toString(),
  })

  if (!saveBidResp.ok) return json({ error: `SaveBid HTTP ${saveBidResp.status}` }, 400)

  let result: { ApiStatusCode?: number; status?: number; Description?: string } = {}
  try { result = await saveBidResp.json() } catch { /* non-JSON response */ }

  const ok = result.ApiStatusCode === 200

  // After placing the bid, refresh the item card to get current bid + winning status.
  // The rendered HTML contains hidden inputs with live server-side values and
  // a "Winning :" / "Outbid :" label regardless of what model JSON we send.
  let winning: boolean | null = null
  let currentBid: number | null = null
  let minimumNextBid: number | null = null

  try {
    const refreshResp = await fetch(`${base}/Public/Auction/RefreshItem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieHeader(cookies),
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        __RequestVerificationToken: bidCsrf,
        model: JSON.stringify({
          AuctionId: Number(params.auctionId),
          AuctionItemId: Number(params.auctionItemId),
          TenantId: Number(formFields.TenantId ?? '399'),
          IsBiddingEnabled: true,
          DisplayFormatCode: 'OB',
          StatusCode: 'NW',
        }),
        index: '1',
        viewType: '2',
        auctionItemFilterVM: JSON.stringify({
          AuctionId: params.auctionId,
          AuctionItemId: Number(params.auctionItemId),
          pageNumber: '1',
          itemsPerPage: 100,
          viewType: '2',
          Filter: 'Current',
          activeTab: 1,
          __RequestVerificationToken: bidCsrf,
        }),
      }).toString(),
    })
    const html = await refreshResp.text()
    const cbMatch = html.match(/name="CurrentBidAmount"[^>]*value="([^"]+)"/)
    const mnbMatch = html.match(/name="MinimumNextBidAmount"[^>]*value="([^"]+)"/)
    currentBid = cbMatch ? parseFloat(cbMatch[1]) : null
    minimumNextBid = mnbMatch ? parseFloat(mnbMatch[1]) : null
    if (html.includes('<span>Winning :')) winning = true
    else if (html.includes('<span>Outbid :')) winning = false
  } catch { /* non-fatal — SaveBid result is still returned */ }

  return json({
    ok,
    status: result.status,
    description: result.Description ?? (ok ? 'Bid placed' : 'Bid failed'),
    winning,
    currentBid,
    minimumNextBid,
  }, ok ? 200 : 400)
}

// ── Entry point ───────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'Unauthorized' }, 401)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data: { user }, error: authError } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', ''),
  )
  if (authError || !user) return json({ error: 'Unauthorized' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { action, username, password } = body

  switch (action) {
    case 'save_credentials':
      if (!username || !password) return json({ error: 'username and password required' }, 400)
      return saveCredentials(supabase, user.id, String(username), String(password))
    case 'delete_credentials':
      return deleteCredentials(supabase, user.id)
    case 'get_status':
      return getStatus(supabase, user.id)
    case 'get_bids':
      return getBids(supabase, user.id)
    case 'place_bid': {
      const { auctionItemId, auctionId, newBidAmount, maxBidAmount, currentBid, minimumNextBid,
              itemName, endDate, totalBids, category, skuNumber } = body
      if (!auctionItemId || !auctionId || newBidAmount == null || currentBid == null || minimumNextBid == null) {
        return json({ error: 'auctionItemId, auctionId, newBidAmount, currentBid, minimumNextBid required' }, 400)
      }
      if (Number(newBidAmount) < Number(minimumNextBid)) {
        return json({ error: `Bid must be at least $${minimumNextBid}` }, 400)
      }
      return placeBid(supabase, user.id, {
        auctionItemId: String(auctionItemId),
        auctionId: String(auctionId),
        newBidAmount: Number(newBidAmount),
        maxBidAmount: Number(maxBidAmount ?? 0),
        currentBid: Number(currentBid),
        minimumNextBid: Number(minimumNextBid),
        itemName: itemName != null ? String(itemName) : undefined,
        endDate: endDate != null ? String(endDate) : undefined,
        totalBids: totalBids != null ? Number(totalBids) : undefined,
        category: category != null ? String(category) : undefined,
        skuNumber: skuNumber != null ? String(skuNumber) : undefined,
      })
    }
    default:
      return json({ error: `Unknown action: ${action}` }, 400)
  }
})
