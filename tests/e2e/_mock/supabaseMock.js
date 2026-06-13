// Network mock for the E2E suite: intercept every Supabase PostgREST / Auth
// request and fulfil it from the local fixture (./data.js) so the tests never
// touch the production database. This is the fix for E2E "strangling" prod —
// 109 tests each used to page the full ~6.5K-lot dataset out of Supabase on
// every `beforeEach`.
//
// We match on the *path* (`**/rest/v1/**`, `**/auth/v1/**`), NOT the host, on
// purpose: even if a stray `.env.local` points the dev server at the real
// project, all PostgREST/auth traffic is still caught here and nothing reaches
// prod. The playwright.config webServer also pins a dead-end URL as a second
// layer of defence.

import { activeLots, archivedLots, enrichmentRows, fullImagesByKey } from './data.js'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range, content-location',
}

// Which lots each full (non-card) view is allowed to return, so the detail
// panel's "try active view, then archived" probe behaves like prod.
const activeKeys = new Set(activeLots.map(l => `${l.auction_safe_id}:${l.item_id}`))
const archivedKeys = new Set(archivedLots.map(l => `${l.auction_safe_id}:${l.item_id}`))

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  })
}

// PostgREST encodes filters as `col=eq.value`; pull a single eq-value out.
function eqValue(params, col) {
  const raw = params.get(col)
  if (!raw) return null
  return raw.startsWith('eq.') ? raw.slice(3) : raw
}

// `.single()` / `.maybeSingle()` ask for a bare object via this Accept type.
function wantsSingle(request) {
  return (request.headers()['accept'] || '').includes('application/vnd.pgrst.object+json')
}

async function handleRest(route, url) {
  const request = route.request()
  const params = url.searchParams
  // /rest/v1/<view>  or  /rest/v1/rpc/<fn>
  const after = url.pathname.split('/rest/v1/')[1] || ''
  const isRpc = after.startsWith('rpc/')
  const name = isRpc ? after.slice('rpc/'.length) : after

  if (isRpc) {
    // match_lots (semantic search), rank_for_you, etc. — empty result is a
    // valid "no matches" state and keeps these features inert in tests.
    return json(route, [])
  }

  switch (name) {
    case 'public_active_lots_card':
      return json(route, activeLots)
    case 'public_archived_lots_card':
      return json(route, archivedLots)

    // Full-image hydration on detail open (select=images, maybeSingle).
    case 'public_active_lots':
    case 'public_archived_lots': {
      const key = `${eqValue(params, 'auction_safe_id')}:${eqValue(params, 'item_id')}`
      const allowed = name === 'public_active_lots' ? activeKeys : archivedKeys
      const images = allowed.has(key) ? fullImagesByKey[key] : null
      if (wantsSingle(request)) return json(route, images ? { images } : null)
      return json(route, images ? [{ images }] : [])
    }

    case 'public_lot_enrichment': {
      const sid = eqValue(params, 'auction_safe_id')
      return json(route, enrichmentRows.filter(r => !sid || r.auction_safe_id === sid))
    }

    // Members-only views: gated behind auth, and the suite runs logged-out, so
    // these aren't requested — return empty as a safety net regardless.
    case 'public_auction_comps':
    case 'public_cannons_comps':
    case 'public_category_sold_stats':
      return json(route, [])

    default:
      // Unknown view: empty result rather than a hard failure, so an unmocked
      // read can't flake the suite (and still never reaches prod).
      return json(route, wantsSingle(request) ? null : [])
  }
}

/**
 * Install the Supabase mock on a Playwright browser context. Call before the
 * first navigation; it covers every page/popup in the context.
 */
export async function installSupabaseMock(context) {
  await context.route('**/rest/v1/**', async route => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' })
    }
    await handleRest(route, new URL(request.url()))
  })

  // Auth: logged-out sessions read from localStorage (no network), but pin a
  // benign response so any stray /auth/v1 call can't escape to prod or error.
  await context.route('**/auth/v1/**', route => {
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' })
    }
    return json(route, {})
  })
}
