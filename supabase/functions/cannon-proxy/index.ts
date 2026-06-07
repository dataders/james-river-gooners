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
import {
  mergeCookies,
  cookieHeader,
  parseHiddenInputs,
  parseBidderId,
  parseRefreshItemHtml,
  parseWatchlistItems,
} from './parsers.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

// ── Crypto helpers ────────────────────────────────────────────────────────────

function requireEncryptionKey(): string {
  const key = Deno.env.get('CANNON_ENCRYPTION_KEY') ?? ''
  if (key.length < 16) {
    throw new Error('CANNON_ENCRYPTION_KEY is not set or too weak (minimum 16 characters)')
  }
  return key
}

async function getKey(rawKey: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(rawKey.padEnd(32, '0').slice(0, 32))
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function encryptText(plaintext: string): Promise<string> {
  const key = await getKey(requireEncryptionKey())
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  const combined = new Uint8Array(12 + encrypted.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(encrypted), 12)
  return btoa(String.fromCharCode(...combined))
}

async function decryptText(ciphertext: string): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0))
  const key = await getKey(requireEncryptionKey())
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  )
  return new TextDecoder().decode(decrypted)
}

// ── Maxanet helpers ───────────────────────────────────────────────────────────

// headers.get('set-cookie') joins multiple Set-Cookie headers with ', ' (comma-space),
// but parseCookies splits on ',(?=[^ ])' (comma NOT followed by space), so the join
// boundary is never matched and only the first cookie survives.
// Strategy (most to least reliable):
//   1. getSetCookie() — returns full array; Deno 1.40+
//   2. iterate headers directly — avoids the join entirely; works in all versions
//   3. fallback split on comma-nonspace from the joined string
function getSetCookies(headers: Headers): Record<string, string> {
  let list: string[]
  const h = headers as Headers & { getSetCookie?(): string[] }
  if (typeof h.getSetCookie === 'function') {
    list = h.getSetCookie()
  } else {
    // forEach is universally available; note callback order is (value, name)
    list = []
    headers.forEach((value, name) => {
      if (name.toLowerCase() === 'set-cookie') list.push(value)
    })
    // If forEach also joined them into one string, split on comma-nonspace
    if (list.length === 1) {
      list = list[0].split(/,(?=[^ ])/).map(s => s.trim())
    }
  }
  const out: Record<string, string> = {}
  for (const entry of list) {
    const pair = entry.split(';')[0].trim()
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

interface LoginResult {
  cookies: Record<string, string>
  loginPostTo: string
  loginPostCookieKeys: string[]
  loginPostRawSetCookie: string
  bidHistoryHtml?: string
  bidHistoryUrl?: string
}

async function maxanetLogin(username: string, password: string): Promise<LoginResult> {
  const base = 'https://bid.cannonsauctions.com'
  // The login page at /Public/Account/Login has JavaScript that intercepts the
  // form submit and POSTs credentials to /Public/Login/Login as an AJAX request
  // (X-Requested-With: XMLHttpRequest). This AJAX endpoint is what issues .ASPXAUTH.
  // Posting to the form's HTML action (/Public/Account/Login) does NOT set it.
  const loginPageUrl = `${base}/Public/Account/Login`
  const loginAjaxUrl = `${base}/Public/Login/Login`

  // Step 1 — fetch login page for anti-forgery token + initial session cookies
  const pageResp = await fetch(loginPageUrl, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  })
  if (!pageResp.ok) throw new Error(`Login page returned ${pageResp.status}`)

  const pageHtml = await pageResp.text()
  const cookies = getSetCookies(pageResp.headers)

  const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  const verificationToken = tokenMatch?.[1] ?? ''

  const tenantMatch = pageHtml.match(/name="TenantCode"[^>]*value="([^"]+)"/)
  const tenantCode = tenantMatch?.[1] ?? ''

  const usernameFieldMatch =
    pageHtml.match(/name="(Email|UserName|Username)"[^>]*type="(?:text|email)"/i) ??
    pageHtml.match(/type="(?:text|email)"[^>]*name="(Email|UserName|Username)"/i)
  const usernameField = usernameFieldMatch?.[1] ?? 'Username'

  console.log('[cannon-proxy] login page:', loginPageUrl, '| token:', !!verificationToken, '| tenant:', tenantCode || '(empty)', '| usernameField:', usernameField)

  // Step 2 — POST credentials to the AJAX login endpoint.
  // ReturnUrl=/ matches what the browser JS sends (the page root, not a deep link).
  const loginBody: Record<string, string> = {
    ReturnUrl: '/',
    TenantCode: tenantCode,
    Password: password,
    __RequestVerificationToken: verificationToken,
  }
  loginBody[usernameField] = username

  const loginResp = await fetch(loginAjaxUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'Referer': loginPageUrl,
      'Origin': base,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams(loginBody).toString(),
    redirect: 'manual',
  })

  const loginPostTo = loginResp.headers.get('location') ?? ''
  const loginPostCookies = getSetCookies(loginResp.headers)
  const loginPostCookieKeys = Object.keys(loginPostCookies)
  const loginPostRawSetCookie = loginResp.headers.get('set-cookie') ?? ''

  let sessionCookies = mergeCookies(cookies, loginPostCookies)

  console.log(`[cannon-proxy] login AJAX POST: status=${loginResp.status} newCookies=${loginPostCookieKeys.join(',') || 'none'} hasAspxAuth=${'.ASPXAUTH' in loginPostCookies}`)

  // The AJAX endpoint returns 200 JSON on success (not a redirect).
  // Parse to detect failure (server returns a non-success status/message).
  let loginJson: Record<string, unknown> = {}
  if (loginResp.status === 200) {
    try { loginJson = await loginResp.json() } catch { /* ignore non-JSON */ }
    const succeeded = loginJson.Succeeded ?? loginJson.succeeded ?? loginJson.success ?? loginJson.Status
    if (succeeded === false || succeeded === 'false') {
      const msg = String(loginJson.Message ?? loginJson.message ?? loginJson.Error ?? 'Invalid credentials')
      throw new Error(`Login failed: ${msg}`)
    }
  } else if (loginResp.status === 302) {
    // Some deployments still redirect on success; check it's not back to login
    if (/\/Login\//i.test(loginPostTo) || /\/Account\/Login/i.test(loginPostTo)) {
      throw new Error(`Login failed: bad credentials (redirected to ${loginPostTo})`)
    }
    await loginResp.text()
  } else {
    await loginResp.text()
    throw new Error(`Unexpected login response: ${loginResp.status}`)
  }

  // If .ASPXAUTH wasn't on the AJAX response, try the redirect URL from JSON.
  // Some deployments include a redirectUrl in the JSON that, when fetched,
  // triggers FormsAuthentication.SetAuthCookie() server-side.
  let bidHistoryHtml: string | undefined
  let bidHistoryUrl: string | undefined

  if (!('.ASPXAUTH' in sessionCookies)) {
    const redirectUrl = String(loginJson.url ?? loginJson.Url ?? loginJson.redirectUrl ?? loginJson.RedirectUrl ?? '')
    const nextHop = redirectUrl
      ? (redirectUrl.startsWith('http') ? redirectUrl : `${base}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`)
      : `${base}/Public`
    let nextUrl: string | null = nextHop
    let hops = 0
    while (nextUrl && hops < 6) {
      hops++
      const hopUrl = nextUrl
      try {
        const hopResp = await fetch(hopUrl, {
          headers: {
            'Cookie': cookieHeader(sessionCookies),
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': loginPageUrl,
          },
          redirect: 'manual',
        })
        const hopCookies = getSetCookies(hopResp.headers)
        sessionCookies = mergeCookies(sessionCookies, hopCookies)
        console.log(`[cannon-proxy] post-login hop ${hops}: status=${hopResp.status} url=${hopUrl} newCookies=${Object.keys(hopCookies).join(',') || '(none)'}`)
        if (hopResp.status === 302) {
          const loc = hopResp.headers.get('location')
          nextUrl = loc ? (loc.startsWith('http') ? loc : `${base}${loc.startsWith('/') ? '' : '/'}${loc}`) : null
        } else {
          nextUrl = null
          if (!('.ASPXAUTH' in sessionCookies)) {
            const hopHtml = await hopResp.text()
            const linkMatch = hopHtml.match(/href="([^"]*(?:BidHistory|MyBids|bid-history)[^"]*)"/)
            if (linkMatch) {
              const href = linkMatch[1]
              bidHistoryUrl = href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`
            }
          } else {
            await hopResp.body?.cancel()
          }
        }
      } catch (e) {
        console.log(`[cannon-proxy] post-login hop ${hops} failed:`, (e as Error).message)
        nextUrl = null
      }
    }
  }

  console.log('[cannon-proxy] session cookie keys after login:', Object.keys(sessionCookies).join(', '))
  return { cookies: sessionCookies, loginPostTo, loginPostCookieKeys, loginPostRawSetCookie, bidHistoryHtml, bidHistoryUrl }
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
    const { winning, currentBid, minimumNextBid } = parseRefreshItemHtml(await resp.text())
    return { auctionItemId: itemId, winning, currentBid, minimumNextBid }
  } catch {
    return { auctionItemId: itemId, winning: null, currentBid: null, minimumNextBid: null }
  }
}

// Fetches a CSRF token by loading one watchlist item from an authenticated session.
async function fetchCsrf(cookies: Record<string, string>, base: string): Promise<string> {
  try {
    const resp = await fetch(
      `${base}/Public/Auction/GetWatchlist?Page=1&itemsPerPage=1&auctionFilter=&filter=&searchFilter=&statusFilter=Current`,
      {
        headers: {
          'Cookie': cookieHeader(cookies),
          'User-Agent': UA,
          'Accept': '*/*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': `${base}/Public/Auction/Watchlist`,
        },
        redirect: 'manual',
      },
    )
    if (resp.ok) {
      const html = await resp.text()
      return html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] ?? ''
    }
  } catch { /* non-fatal */ }
  return ''
}

async function fetchBidHistory(cookies: Record<string, string>): Promise<{ itemIds: string[]; items: BidItem[]; csrf: string; bidderId: string | null }> {
  const base = 'https://bid.cannonsauctions.com'

  // GetWatchlist AJAX — returns one item card per active watched bid.
  // Auth for this area was already activated in maxanetLogin via /Authentication/Login.
  const url = `${base}/Public/Auction/GetWatchlist?Page=1&itemsPerPage=100&auctionFilter=&filter=&searchFilter=&statusFilter=Current`
  console.log('[cannon-proxy] fetching watchlist items')

  const resp = await fetch(url, {
    headers: {
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'Accept': '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${base}/Public/Auction/Watchlist`,
    },
    redirect: 'manual',
  })

  const cookieKeys = Object.keys(cookies).join(',')
  console.log('[cannon-proxy] GetWatchlist status:', resp.status, '| cookies:', cookieKeys)
  if (resp.status === 302) {
    const redirectTo = resp.headers.get('location') ?? '?'
    throw new Error(`GetWatchlist→${redirectTo.slice(0, 100)}, cookies: ${cookieKeys}`)
  }
  if (!resp.ok) throw new Error(`GetWatchlist returned ${resp.status}`)

  const html = await resp.text()
  const items = parseWatchlistItems(html)
  const csrf = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] ?? ''
  const bidderId = parseBidderId(html)
  console.log('[cannon-proxy] watchlist items:', items.length, '| csrf:', !!csrf)
  return { itemIds: items.map(b => b.itemId), items, csrf, bidderId }
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

// Full HTTP trace of the login flow: follows every redirect manually and
// records status, Location, and Set-Cookie at each hop so we can see exactly
// where (or whether) .ASPXAUTH is issued.
async function debugAuthV2(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { data } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return json({ error: 'No credentials stored' }, 400)

  const base = 'https://bid.cannonsauctions.com'
  const password = await decryptText(data.cannon_password_enc)

  const trace: Array<{
    step: string
    url: string
    method: string
    status: number
    location: string | null
    setCookieRaw: string[]
    newCookieKeys: string[]
    sessionCookieKeys: string[]
  }> = []

  let sessionCookies: Record<string, string> = {}

  async function hop(step: string, url: string, method: 'GET' | 'POST', body?: string): Promise<{ status: number; location: string | null; html: string }> {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cookie': cookieHeader(sessionCookies),
    }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Referer'] = url
    }
    const resp = await fetch(url, { method, headers, body, redirect: 'manual' })
    const rawSetCookies: string[] = (resp as Response & { headers: Headers & { getSetCookie?(): string[] } }).headers.getSetCookie?.() ?? []
    const newCookies = getSetCookies(resp.headers)
    sessionCookies = mergeCookies(sessionCookies, newCookies)
    const html = resp.status !== 302 ? await resp.text() : ''
    trace.push({
      step,
      url,
      method,
      status: resp.status,
      location: resp.headers.get('location'),
      setCookieRaw: rawSetCookies,
      newCookieKeys: Object.keys(newCookies),
      sessionCookieKeys: Object.keys(sessionCookies),
    })
    return { status: resp.status, location: resp.headers.get('location'), html }
  }

  // Chain: follow redirects manually from a starting URL
  async function followChain(startUrl: string, startMethod: 'GET' | 'POST', startBody?: string) {
    let url: string | null = startUrl
    let method: 'GET' | 'POST' = startMethod
    let body: string | undefined = startBody
    let hopCount = 0
    while (url && hopCount < 8) {
      hopCount++
      const { status, location, html } = await hop(`hop${hopCount}`, url, method, body)
      if (status === 302 && location) {
        url = location.startsWith('http') ? location : `${base}${location.startsWith('/') ? '' : '/'}${location}`
        method = 'GET'
        body = undefined
      } else {
        // 200 — extract form fields for diagnostic
        const formInputs: Record<string, string> = {}
        for (const m of html.matchAll(/<input[^>]+>/gi)) {
          const tag = m[0]
          const name = tag.match(/name="([^"]+)"/)?.[1]
          const value = tag.match(/value="([^"]*)"/)?.[1] ?? ''
          const type = tag.match(/type="([^"]+)"/i)?.[1] ?? 'text'
          if (name) formInputs[name] = `[${type}] ${value.slice(0, 30)}`
        }
        trace.push({ step: 'formInputs', url, method, status: 0, location: null, setCookieRaw: [], newCookieKeys: [], sessionCookieKeys: Object.keys(sessionCookies) } as typeof trace[0])
        ;(trace[trace.length - 1] as Record<string, unknown>).formInputs = formInputs
        ;(trace[trace.length - 1] as Record<string, unknown>).finalUrl = url
        break
      }
    }
  }

  // Step A: GET /Public/Account/Login directly.
  // /Authentication/Login on this instance just redirects to /Public (the
  // homepage), so we skip it and go straight to the user-facing login form.
  const landingUrl = `${base}/Public/Account/Login`
  await followChain(landingUrl, 'GET')

  // Step B: re-fetch the login page to extract form fields
  // (followChain captured cookies; now read the HTML to parse the form)
  const loginPage = await fetch(landingUrl, {
    headers: { 'User-Agent': UA, 'Cookie': cookieHeader(sessionCookies) },
    redirect: 'follow',
  })
  const newPageCookies = getSetCookies(loginPage.headers)
  sessionCookies = mergeCookies(sessionCookies, newPageCookies)
  const loginHtml = await loginPage.text()
  const verificationToken = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] ?? ''
  const tenantCode = loginHtml.match(/name="TenantCode"[^>]*value="([^"]+)"/)?.[1] ?? ''
  const discoveredFormAction = loginHtml.match(/<form[^>]+action="([^"]+)"/)?.[1]
  const loginPostUrl = discoveredFormAction
    ? (discoveredFormAction.startsWith('http') ? discoveredFormAction : `${base}${discoveredFormAction}`)
    : landingUrl
  const usernameField =
    (loginHtml.match(/name="(Email|UserName|Username)"[^>]*type="(?:text|email)"/i) ??
     loginHtml.match(/type="(?:text|email)"[^>]*name="(Email|UserName|Username)"/i))?.[1] ?? 'Username'

  const allInputs: Record<string, string> = {}
  for (const m of loginHtml.matchAll(/<input[^>]+>/gi)) {
    const tag = m[0]
    const name = tag.match(/name="([^"]+)"/)?.[1]
    const type = tag.match(/type="([^"]+)"/i)?.[1] ?? 'text'
    if (name) allInputs[name] = type
  }

  // Step C: POST credentials to /Public/Login/Login — the AJAX endpoint the browser
  // JS uses (not the HTML form action). ReturnUrl=/ matches what the browser sends.
  const ajaxLoginUrl = `${base}/Public/Login/Login`
  const loginBody: Record<string, string> = {
    ReturnUrl: '/',
    TenantCode: tenantCode,
    Password: '***',
    __RequestVerificationToken: verificationToken,
  }
  loginBody[usernameField] = data.cannon_username

  const realLoginBody: Record<string, string> = { ...loginBody, Password: password }

  // hop() sends via followChain infrastructure but we need X-Requested-With here
  const ajaxResp = await fetch(ajaxLoginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(sessionCookies),
      'User-Agent': UA,
      'Referer': landingUrl,
      'Origin': base,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams(realLoginBody).toString(),
    redirect: 'manual',
  })
  const ajaxCookies = getSetCookies(ajaxResp.headers)
  const ajaxRaw: string[] = (ajaxResp as Response & { headers: Headers & { getSetCookie?(): string[] } }).headers.getSetCookie?.() ?? []
  sessionCookies = mergeCookies(sessionCookies, ajaxCookies)
  let ajaxBody = ''
  try { ajaxBody = await ajaxResp.text() } catch { /* ignore */ }
  trace.push({
    step: 'step_C_ajax_login',
    url: ajaxLoginUrl,
    method: 'POST',
    status: ajaxResp.status,
    location: ajaxResp.headers.get('location'),
    setCookieRaw: ajaxRaw,
    newCookieKeys: Object.keys(ajaxCookies),
    sessionCookieKeys: Object.keys(sessionCookies),
  } as typeof trace[0])
  ;(trace[trace.length - 1] as Record<string, unknown>).responseBody = ajaxBody.slice(0, 200)

  // Step D: after a successful /Public/Account/Login, try GET /Authentication/Login
  // with the authenticated session. In some Maxanet deployments this endpoint acts
  // as an SSO bridge — when the Maxanet session is already authenticated it fires
  // FormsAuthentication.SetAuthCookie() and issues .ASPXAUTH.
  // Also try with a ReturnUrl in case the route handler checks it.
  for (const suffix of ['', '?ReturnUrl=%2fPublic%2fAuction%2fWatchlist']) {
    const authUrl = `${base}/Authentication/Login${suffix}`
    const authResp = await fetch(authUrl, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': cookieHeader(sessionCookies),
        'Referer': `${base}/Public`,
      },
      redirect: 'manual',
    })
    const authCookies = getSetCookies(authResp.headers)
    const authRaw: string[] = (authResp as Response & { headers: Headers & { getSetCookie?(): string[] } }).headers.getSetCookie?.() ?? []
    sessionCookies = mergeCookies(sessionCookies, authCookies)
    trace.push({
      step: `step_D_auth_login${suffix ? '_with_returnurl' : ''}`,
      url: authUrl,
      method: 'GET',
      status: authResp.status,
      location: authResp.headers.get('location'),
      setCookieRaw: authRaw,
      newCookieKeys: Object.keys(authCookies),
      sessionCookieKeys: Object.keys(sessionCookies),
    } as typeof trace[0])
    if ('.ASPXAUTH' in authCookies) break
  }

  // Step E: try GetWatchlist with the final session (may now have .ASPXAUTH)
  const wlResp = await fetch(
    `${base}/Public/Auction/GetWatchlist?Page=1&itemsPerPage=100&auctionFilter=&filter=&searchFilter=&statusFilter=Current`,
    {
      headers: {
        'Cookie': cookieHeader(sessionCookies),
        'User-Agent': UA,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': `${base}/Public/Auction/Watchlist`,
      },
      redirect: 'manual',
    }
  )
  const wlStatus = wlResp.status
  const wlLocation = wlResp.headers.get('location')

  return json({
    username: data.cannon_username,
    landingUrl,
    loginPostUrl,
    usernameField,
    formInputsOnLoginPage: allInputs,
    hasToken: !!verificationToken,
    tenantCode,
    loginBodySent: loginBody,
    finalSessionCookies: Object.keys(sessionCookies),
    hasAspxAuth: '.ASPXAUTH' in sessionCookies,
    watchlistStatus: wlStatus,
    watchlistLocation: wlLocation,
    trace,
  })
}

async function debugLogin(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { data } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return json({ error: 'No credentials stored' }, 400)

  const base = 'https://bid.cannonsauctions.com'

  // Step 1: inspect the login page
  const pageResp = await fetch(`${base}/Public/Account/Login`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  })
  const pageHtml = await pageResp.text()
  const pageCookies = getSetCookies(pageResp.headers)
  const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  const tenantMatch = pageHtml.match(/name="TenantCode"[^>]*value="([^"]+)"/)
  const formActionMatch = pageHtml.match(/<form[^>]+action="([^"]+)"/)

  const diag: Record<string, unknown> = {
    pageStatus: pageResp.status,
    pageUrl: pageResp.url,
    cookieKeys: Object.keys(pageCookies),
    hasToken: !!tokenMatch,
    tokenLength: tokenMatch?.[1]?.length ?? 0,
    tenantCode: tenantMatch?.[1] ?? '(not found)',
    formAction: formActionMatch?.[1] ?? '(not found)',
    username: data.cannon_username,
  }

  // Step 2: attempt login and report the outcome
  try {
    const password = await decryptText(data.cannon_password_enc)
    const cookies = pageCookies
    const verificationToken = tokenMatch?.[1] ?? ''
    const tenantCode = tenantMatch?.[1] ?? ''
    const loginPostUrl = formActionMatch?.[1]
      ? (formActionMatch[1].startsWith('http') ? formActionMatch[1] : `${base}${formActionMatch[1]}`)
      : `${base}/Public/Account/Login`

    const loginResp = await fetch(loginPostUrl, {
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
        Username: data.cannon_username,
        Password: password,
        __RequestVerificationToken: verificationToken,
      }).toString(),
      redirect: 'manual',
    })

    const loginCookies = getSetCookies(loginResp.headers)
    diag.loginStatus = loginResp.status
    diag.loginLocation = loginResp.headers.get('location')
    diag.loginCookieKeys = Object.keys(loginCookies)
    diag.loginPostUrl = loginPostUrl

    if (loginResp.status === 200) {
      const body = await loginResp.text()
      const errMatch = body.match(/class="[^"]*validation-summary[^"]*"[^>]*>([\s\S]{0,300}?)<\//)
      diag.loginError = errMatch ? errMatch[1].replace(/<[^>]+>/g, '').trim() : '(no validation-summary found)'
      diag.hasLoginForm = body.includes('__RequestVerificationToken')
    } else if (loginResp.status === 302) {
      // Follow redirect chain to landing page and dump its nav hrefs
      let nextUrl: string | null = loginResp.headers.get('location')
      if (nextUrl && !nextUrl.startsWith('http')) nextUrl = `${base}${nextUrl.startsWith('/') ? '' : '/'}${nextUrl}`
      const loginCookies2 = mergeCookies(pageCookies, getSetCookies(loginResp.headers))
      let hops = 0
      while (nextUrl && hops < 6) {
        hops++
        const hopUrl = nextUrl
        const hopResp = await fetch(hopUrl, {
          headers: {
            'Cookie': cookieHeader(loginCookies2),
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'manual',
        })
        const hopNewCookies = getSetCookies(hopResp.headers)
        Object.assign(loginCookies2, hopNewCookies)
        if (hopResp.status === 302) {
          const loc = hopResp.headers.get('location')
          nextUrl = loc ? (loc.startsWith('http') ? loc : `${base}${loc.startsWith('/') ? '' : '/'}${loc}`) : null
        } else {
          nextUrl = null
          const hopHtml = await hopResp.text()
          diag.landingUrl = hopUrl
          diag.landingStatus = hopResp.status
          diag.landingIsLoggedIn = hopHtml.includes('logout') || hopHtml.includes('Logout') || hopHtml.includes('log-out') || hopHtml.includes('sign-out')
          // Dump ALL hrefs that look account/bid related
          const hrefs: string[] = []
          for (const m of hopHtml.matchAll(/href="([^"]+)"/gi)) {
            const h = m[1]
            if (/account|bid|history|profile|my[- ]|dashboard/i.test(h)) hrefs.push(h)
          }
          diag.accountHrefs = hrefs
          // Also dump nav link text+href pairs for full picture
          const navLinks: string[] = []
          for (const m of hopHtml.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,60}?)<\/a>/gi)) {
            const href = m[1], text = m[2].replace(/<[^>]+>/g, '').trim()
            if (text && !/^\s*$/.test(text)) navLinks.push(`${text} → ${href}`)
          }
          diag.navLinks = navLinks.slice(0, 40)

          // Probe candidate bid history URLs with the authenticated session
          const candidates = [
            '/Public/Account/BidHistory',
            '/Public/Bidder/BidHistory',
            '/Public/Account/MyBids',
            '/Public/Bidder/MyBids',
            '/Public/Account/History',
            '/Public/Account/BidItems',
            '/Public/Bidder/History',
            '/Public/Auction/BidHistory',
          ]
          const probeResults: Record<string, string> = {}
          for (const path of candidates) {
            try {
              const pr = await fetch(`${base}${path}`, {
                headers: {
                  'Cookie': cookieHeader(loginCookies2),
                  'User-Agent': UA,
                  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                redirect: 'manual',
              })
              probeResults[path] = pr.status === 302
                ? `302→${pr.headers.get('location') ?? '?'}`
                : String(pr.status)
            } catch (e) {
              probeResults[path] = `error: ${(e as Error).message}`
            }
          }
          diag.urlProbe = probeResults
        }
      }
    }
  } catch (e) {
    diag.loginException = (e as Error).message
  }

  return json(diag)
}

async function getBids(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  // Fast path: return stored data if the table is already seeded.
  const { data: storedBids, error: dbError } = await supabase
    .from('user_bids')
    .select('auction_item_id, auction_id, is_winning, current_bid, min_next_bid')
    .eq('user_id', userId)

  if (dbError) return json({ error: dbError.message }, 500)

  if (storedBids && storedBids.length > 0) {
    const itemIds = storedBids.map(r => r.auction_item_id)
    const statuses: BidStatus[] = storedBids.map(r => ({
      auctionItemId: r.auction_item_id,
      winning: r.is_winning,
      currentBid: r.current_bid,
      minimumNextBid: r.min_next_bid,
    }))
    return json({ itemIds, statuses })
  }

  // Zero rows: one-time seed from Maxanet watchlist for existing users.
  const { data: creds, error: credsError } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()

  if (credsError) return json({ error: credsError.message }, 500)
  if (!creds) return json({ itemIds: [], statuses: [] })

  let password: string
  try {
    password = await decryptText(creds.cannon_password_enc)
  } catch {
    return json({ error: 'Failed to decrypt stored credentials' }, 500)
  }

  let loginResult: LoginResult
  try {
    loginResult = await maxanetLogin(creds.cannon_username, password)
  } catch (e: unknown) {
    return json({ error: `Cannon's login failed: ${(e as Error).message}` }, 400)
  }
  const { cookies } = loginResult

  let history: { itemIds: string[]; items: BidItem[]; csrf: string; bidderId: string | null }
  try {
    history = await fetchBidHistory(cookies)
  } catch (e: unknown) {
    return json({ error: `Watchlist fetch failed: ${(e as Error).message}` }, 400)
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

  // Seed user_bids so future calls hit the fast path.
  if (history.items.length > 0) {
    const now = new Date().toISOString()
    const rows = history.items.map(item => {
      const status = statuses.find(s => s.auctionItemId === item.itemId)
      return {
        user_id: userId,
        auction_item_id: item.itemId,
        auction_id: item.auctionId || null,
        is_winning: status?.winning ?? null,
        current_bid: status?.currentBid ?? null,
        min_next_bid: status?.minimumNextBid ?? null,
        last_bid_at: now,
        status_refreshed_at: now,
      }
    })
    await supabase
      .from('user_bids')
      .upsert(rows, { onConflict: 'user_id,auction_item_id' })
  }

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
    ({ cookies } = await maxanetLogin(data.cannon_username, password))
  } catch (e: unknown) {
    return json({ error: `Cannon's login failed: ${(e as Error).message}` }, 400)
  }

  const base = 'https://bid.cannonsauctions.com'

  // Fetch the item page to get a fresh CSRF token for this session.
  // Follow redirects manually (up to 5 hops) — Maxanet sometimes issues a
  // session-establishment redirect before serving the page, and redirect:'manual'
  // would have incorrectly treated that as "session expired". Only bail if the
  // redirect target is the login page (genuine session expiry). Fall back to the
  // watchlist CSRF endpoint if the item page doesn't yield a token.
  let itemPageUrl = `${base}/Public/Auction/AuctionItemDetail?AuctionItemId=${params.auctionItemId}&AuctionId=${params.auctionId}`
  let itemHtml = ''
  for (let hop = 0; hop < 5; hop++) {
    const resp = await fetch(itemPageUrl, {
      headers: { Cookie: cookieHeader(cookies), 'User-Agent': UA },
      redirect: 'manual',
    })
    cookies = mergeCookies(cookies, getSetCookies(resp.headers))
    if (resp.status === 302) {
      const loc = resp.headers.get('location') ?? ''
      console.log(`[cannon-proxy] item page redirect hop ${hop + 1}: ${itemPageUrl} → ${loc}`)
      if (/\/Login\//i.test(loc) || /\/Account\/Login/i.test(loc)) {
        return json({ error: 'Session expired fetching item page' }, 400)
      }
      if (!loc) break
      itemPageUrl = loc.startsWith('http') ? loc : `${base}${loc.startsWith('/') ? '' : '/'}${loc}`
      continue
    }
    itemHtml = await resp.text()
    break
  }
  const itemCsrf = itemHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1]
    ?? await fetchCsrf(cookies, base)

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
  cookies = mergeCookies(cookies, getSetCookies(submitResp.headers))
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
    ;({ winning, currentBid, minimumNextBid } = parseRefreshItemHtml(await refreshResp.text()))
  } catch { /* non-fatal — SaveBid result is still returned */ }

  // Persist to user_bids on success so the hook has a durable record.
  // first_bid_at is omitted intentionally: the DB default sets it on INSERT
  // and the upsert preserves the existing value on UPDATE.
  if (ok) {
    const now = new Date().toISOString()
    await supabase.from('user_bids').upsert({
      user_id: userId,
      auction_item_id: params.auctionItemId,
      auction_id: params.auctionId,
      item_title: params.itemName ?? null,
      item_category: params.category ?? null,
      bid_amount: params.newBidAmount,
      last_bid_at: now,
      is_winning: winning,
      current_bid: currentBid,
      min_next_bid: minimumNextBid,
      status_refreshed_at: winning !== null ? now : null,
    }, { onConflict: 'user_id,auction_item_id' })
  }

  return json({
    ok,
    status: result.status,
    description: result.Description ?? (ok ? 'Bid placed' : 'Bid failed'),
    winning,
    currentBid,
    minimumNextBid,
  }, ok ? 200 : 400)
}

// Refreshes live bid status (winning/currentBid/minNextBid) for all non-closed
// user_bids rows by re-authenticating with Maxanet and calling RefreshItem.
// Updates the status columns in-place; does not add or remove rows.
async function refreshBidStatuses(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<Response> {
  const { data: bids, error: dbError } = await supabase
    .from('user_bids')
    .select('auction_item_id, auction_id')
    .eq('user_id', userId)
    .eq('item_closed', false)

  if (dbError) return json({ error: dbError.message }, 500)
  if (!bids || bids.length === 0) return json({ itemIds: [], statuses: [] })

  const { data: creds, error: credsError } = await supabase
    .from('cannon_credentials')
    .select('cannon_username, cannon_password_enc')
    .eq('user_id', userId)
    .maybeSingle()

  if (credsError) return json({ error: credsError.message }, 500)
  if (!creds) return json({ error: "No Cannon's account linked" }, 400)

  let password: string
  try {
    password = await decryptText(creds.cannon_password_enc)
  } catch {
    return json({ error: 'Failed to decrypt stored credentials' }, 500)
  }

  let loginResult: LoginResult
  try {
    loginResult = await maxanetLogin(creds.cannon_username, password)
  } catch (e: unknown) {
    return json({ error: `Cannon's login failed: ${(e as Error).message}` }, 400)
  }
  const { cookies } = loginResult

  const base = 'https://bid.cannonsauctions.com'
  const csrf = await fetchCsrf(cookies, base)
  // Cap at 20 to avoid flooding Maxanet with concurrent requests
  const items: BidItem[] = bids.map(r => ({ itemId: r.auction_item_id, auctionId: r.auction_id ?? '0' }))
  const toRefresh = items.slice(0, 20)
  const statuses: BidStatus[] = await Promise.all(
    toRefresh.map(item => refreshItemStatus(base, cookies, csrf, item))
  )

  if (statuses.length > 0) {
    const now = new Date().toISOString()
    const updates = statuses.map(s => ({
      user_id: userId,
      auction_item_id: s.auctionItemId,
      is_winning: s.winning,
      current_bid: s.currentBid,
      min_next_bid: s.minimumNextBid,
      status_refreshed_at: now,
    }))
    await supabase
      .from('user_bids')
      .upsert(updates, { onConflict: 'user_id,auction_item_id' })
  }

  return json({
    itemIds: bids.map(r => r.auction_item_id),
    statuses,
  })
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
    case 'refresh_bid_statuses':
      return refreshBidStatuses(supabase, user.id)
    case 'debug_login':
      return debugLogin(supabase, user.id)
    case 'debug_auth_v2':
      return debugAuthV2(supabase, user.id)
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
