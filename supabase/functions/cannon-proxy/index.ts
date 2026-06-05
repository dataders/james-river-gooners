// Cannon's/Maxanet proxy — Supabase Edge Function
//
// Actions (POST body JSON):
//   save_credentials  { username, password }  → store encrypted credentials
//   delete_credentials                         → remove credentials
//   get_status                                 → { linked, username }
//   get_bids                                   → { itemIds: string[] }
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
// NOTE: These endpoint URLs are best guesses from the ASP.NET MVC patterns
// observed in the public scraper. Verify by inspecting Network tab while
// logging in to bid.cannonsauctions.com manually.

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

  // Extract ASP.NET anti-forgery token (present in all standard MVC login forms)
  const tokenMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
  const verificationToken = tokenMatch?.[1] ?? ''

  // Step 2 — POST credentials
  const loginResp = await fetch(`${base}/Public/Account/Login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
      'User-Agent': UA,
      'Referer': `${base}/Public/Account/Login`,
    },
    body: new URLSearchParams({
      Email: username,
      Password: password,
      RememberMe: 'false',
      __RequestVerificationToken: verificationToken,
    }).toString(),
    redirect: 'manual', // catch redirect so we can check status
  })

  // Successful login → 302 redirect away from /Account/Login
  // Failed login → 200 (re-renders the form with an error message)
  if (loginResp.status === 200) {
    const body = await loginResp.text()
    // Look for a server-side validation error message
    const errMatch = body.match(/class="[^"]*validation-summary[^"]*"[^>]*>([\s\S]{0,300}?)<\//)
    throw new Error(errMatch ? `Login failed: ${errMatch[1].replace(/<[^>]+>/g, '').trim()}` : 'Login failed')
  }
  if (loginResp.status !== 302) throw new Error(`Unexpected login response: ${loginResp.status}`)

  const sessionCookies = mergeCookies(cookies, parseCookies(loginResp.headers.get('set-cookie') ?? ''))
  return sessionCookies
}

async function fetchBidHistory(cookies: Record<string, string>): Promise<{ itemIds: string[]; bidderId: string | null }> {
  const base = 'https://bid.cannonsauctions.com'

  // NOTE: /Public/Account/BidHistory is the standard MVC endpoint guess. If this
  // returns 404, try /Public/Account/MyBids or /Public/Account/BiddingHistory,
  // then inspect the Network tab on a live logged-in session to find the real URL.
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
  return { itemIds: parseBidItemIds(html), bidderId: parseBidderId(html) }
}

function parseBidderId(html: string): string | null {
  // Common patterns auction platforms use to display a user's bidder number.
  // These are best-effort regexes; add more once a real BidHistory response
  // can be inspected in DevTools.
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

function parseBidItemIds(html: string): string[] {
  const ids = new Set<string>()

  // Pattern 1: detail URL query param AuctionItemId=<id>
  for (const m of html.matchAll(/AuctionItemId=([^&"'\s]+)/g)) {
    ids.add(decodeURIComponent(m[1]))
  }

  // Pattern 2: hidden BidAuctionItemId inputs (same as the scraper sees on listing pages)
  for (const m of html.matchAll(/BidAuctionItemId[^>]*value="([^"]+)"/g)) {
    ids.add(m[1])
  }

  // Pattern 3: data-item-id attributes
  for (const m of html.matchAll(/data-(?:auction-)?item-id="([^"]+)"/g)) {
    ids.add(m[1])
  }

  return [...ids]
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

  let itemIds: string[]
  let bidderId: string | null
  try {
    ;({ itemIds, bidderId } = await fetchBidHistory(cookies))
  } catch (e: unknown) {
    return json({ error: `Bid history fetch failed: ${(e as Error).message}` }, 400)
  }

  // Auto-populate cannon_bidder_id the first time we see it in a response.
  // Only writes if the field is still null — won't overwrite a manually set value.
  if (bidderId) {
    await supabase
      .from('users')
      .update({ cannon_bidder_id: bidderId })
      .eq('id', userId)
      .is('cannon_bidder_id', null)
  }

  return json({ itemIds })
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

  let body: Record<string, string>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { action, username, password } = body

  switch (action) {
    case 'save_credentials':
      if (!username || !password) return json({ error: 'username and password required' }, 400)
      return saveCredentials(supabase, user.id, username, password)
    case 'delete_credentials':
      return deleteCredentials(supabase, user.id)
    case 'get_status':
      return getStatus(supabase, user.id)
    case 'get_bids':
      return getBids(supabase, user.id)
    default:
      return json({ error: `Unknown action: ${action}` }, 400)
  }
})
