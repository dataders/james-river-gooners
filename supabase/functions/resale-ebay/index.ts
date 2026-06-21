// resale-ebay — Stage 2 of the photo resale report. Live SoldComps keyword
// search for the identified product, with an atomic per-user daily cap and a
// smart-link fallback. Members-only (JWT-gated).
//
// POST body: { searchQuery: string, categoryId?: string }
// Returns:   { status, matches, searchUrl }   (matches = CompRow[])
//
// Secrets: SOLDCOMPS_API_KEY (+ optional SOLDCOMPS_API_URL), SUPABASE_*.
import { requireUser, jsonResponse, CORS_HEADERS } from '../_shared/auth.ts'
import { buildSoldcompsParams, parseSoldcompsItems, decideStatus } from './soldcomps.ts'

const SOLDCOMPS_URL = Deno.env.get('SOLDCOMPS_API_URL') ?? 'https://api.sold-comps.com/v1/scrape'
const DAILY_CAP = 50

// eBay "Sold & Completed" search URL — the smart-link fallback (mirrors ebayComps.js).
function soldSearchUrl(query: string): string {
  const u = new URL('https://www.ebay.com/sch/i.html')
  u.searchParams.set('_nkw', query)
  u.searchParams.set('LH_Sold', '1')
  u.searchParams.set('LH_Complete', '1')
  return u.toString()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const auth = await requireUser(req)
  if ('response' in auth && auth.response) return auth.response
  const { user, supabase } = auth

  let body: { searchQuery?: string; categoryId?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const query = (body.searchQuery ?? '').trim()
  if (!query) return jsonResponse({ status: 'no_results', matches: [], searchUrl: null })

  const searchUrl = soldSearchUrl(query)
  const apiKey = Deno.env.get('SOLDCOMPS_API_KEY')

  // Atomic cap: record + check in one RPC.
  const { data: allowed } = await supabase.rpc('record_resale_scan', { p_user_id: user.id, daily_cap: DAILY_CAP })
  if (allowed === false || !apiKey) {
    return jsonResponse({ status: allowed === false ? 'over_cap' : 'live_error', matches: [], searchUrl })
  }

  try {
    const params = new URLSearchParams(buildSoldcompsParams(query, body.categoryId))
    const res = await fetch(`${SOLDCOMPS_URL}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'james-river-gooners/1.0' },
      signal: AbortSignal.timeout(25_000),
    })
    const payload = res.ok ? await res.json() : {}
    const items = payload.items ?? payload.results ?? []
    const matches = parseSoldcompsItems(items).slice(0, 8)
    return jsonResponse({ status: decideStatus(res.status, matches), matches, searchUrl })
  } catch (err) {
    console.error('resale-ebay error:', err)
    return jsonResponse({ status: 'live_error', matches: [], searchUrl })
  }
})
