// embed-query Edge Function
//
// POST body: { query: string, match_count?: number }
// Returns:   { ids: string[] }  — composite "auction_safe_id:item_id" keys
//
// Embeds the query via the HF Inference API (no WASM download in the browser),
// then calls match_lots. iOS browsers get full semantic search without having
// to load the 23 MB ONNX WASM + 40 MB weights that crash iOS Safari.
//
// Optional secret: HUGGINGFACE_TOKEN — a free HF read token raises the rate
// limit; without it the API still works but is heavily rate-limited.
//
// Auto-injected by Supabase: SUPABASE_URL, SUPABASE_ANON_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const HF_TOKEN = Deno.env.get('HUGGINGFACE_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const TOP_K_MAX = 500
const HF_MODEL = 'nomic-ai/nomic-embed-text-v1.5'

async function embedQuery(query: string): Promise<number[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`

  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ inputs: `search_query: ${query}` }),
    }
  )

  if (!res.ok) {
    throw new Error(`HF Inference API error ${res.status}: ${await res.text()}`)
  }

  // HF feature-extraction returns [[float, ...]] for a single-string input
  let embedding: number[] | number[][] = await res.json()
  if (Array.isArray(embedding[0])) embedding = (embedding as number[][])[0]

  // L2-normalize to match the stored item vectors
  const norm = Math.sqrt((embedding as number[]).reduce((s, v) => s + v * v, 0))
  return norm > 0 ? (embedding as number[]).map(v => v / norm) : (embedding as number[])
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }

  try {
    const { query, match_count = 150 } = await req.json()

    if (!query?.trim()) {
      return new Response(JSON.stringify({ ids: [] }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      })
    }

    const embedding = await embedQuery(query)

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_lots`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: Math.min(match_count, TOP_K_MAX),
      }),
    })

    if (!rpcRes.ok) {
      throw new Error(`match_lots failed: ${rpcRes.status}`)
    }

    const rows: { auction_safe_id: string; item_id: string }[] = await rpcRes.json()
    const ids = rows.map(r => `${r.auction_safe_id}:${r.item_id}`)

    return new Response(JSON.stringify({ ids }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('embed-query error:', err)
    return new Response(JSON.stringify({ ids: [], error: String(err) }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
