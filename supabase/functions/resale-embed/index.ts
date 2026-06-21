// resale-embed — Stage 3 of the photo resale report. Text-only Nomic embedding
// of the identified searchQuery → corpus eBay comps + local sold history via the
// arbitrary-vector RPCs. Members-only (JWT-gated). Vision leg is a later increment.
//
// POST body: { searchQuery: string }
// Returns:   { ebay: { matches }, cannons: { matches }, error? }
import { requireUser, jsonResponse, CORS_HEADERS } from '../_shared/auth.ts'
import { embedText, mapSoldListingRows, mapCannonsRows } from './embed.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

  const auth = await requireUser(req)
  if ('response' in auth && auth.response) return auth.response
  const { supabase } = auth

  let body: { searchQuery?: string }
  try { body = await req.json() } catch { return jsonResponse({ error: 'Invalid JSON' }, 400) }
  const query = (body.searchQuery ?? '').trim()
  if (!query) return jsonResponse({ ebay: { matches: [] }, cannons: { matches: [] } })

  try {
    const vec = await embedText(query, Deno.env.get('HUGGINGFACE_TOKEN') ?? '')
    const [sold, cannons] = await Promise.all([
      supabase.rpc('match_sold_listings_by_vector', { query_embedding: vec, match_count: 8, min_sim: 0.75 }),
      supabase.rpc('match_cannons_comps_by_vector', { query_embedding: vec, match_count: 5, min_sim: 0.75 }),
    ])
    return jsonResponse({
      ebay: { matches: mapSoldListingRows(sold.data ?? []) },
      cannons: { matches: mapCannonsRows(cannons.data ?? []) },
    })
  } catch (err) {
    console.error('resale-embed error:', err)
    return jsonResponse({ ebay: { matches: [] }, cannons: { matches: [] }, error: String(err) })
  }
})
