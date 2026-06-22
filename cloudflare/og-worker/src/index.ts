// og-item Cloudflare Worker
//
// GET ?item=<auctionSafeId>:<itemId>
//
// Returns an HTML page with Open Graph + Twitter Card meta tags for the lot.
// Social crawlers (Slack, Discord, iMessage, X) see the og: tags; human
// visitors are immediately redirected to the SPA deep-link URL via <script>.
//
// Auth: none required — only public fields (title, category, bid, photo) are
// surfaced. Resale comps and auth-gated data are never included.
//
// Cache-Control: 5 min (max-age=300) — bids move; stale previews are fine.
//
// Secrets (set via `wrangler secret put`):
//   SUPABASE_URL      — Supabase project URL
//   SUPABASE_ANON_KEY — Publishable key (browser-safe; lots table is public-read via RLS)
//
// Var (wrangler.toml [vars]):
//   SPA_ORIGIN        — https://gooners.anders.omg.lol

export interface Env {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SPA_ORIGIN: string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface LotRow {
  title: string | null
  current_bid: number | null
  final_bid: number | null
  closed: boolean | null
  total_bids: number | null
  images: string[] | null
  raw_category: string | null
  category: string | null
  auction_title: string | null
}

function buildHtml(lot: LotRow, spaUrl: string, spaOrigin: string): string {
  const title = lot.title ?? ''
  const category = lot.raw_category ?? lot.category ?? ''
  const bid = lot.closed
    ? (lot.final_bid != null ? `Sold for $${lot.final_bid.toLocaleString()}` : '')
    : (lot.current_bid != null ? `Current bid: $${lot.current_bid.toLocaleString()}` : '')
  const bids = (lot.total_bids ?? 0) > 0
    ? `${lot.total_bids} bid${lot.total_bids !== 1 ? 's' : ''}`
    : ''
  const auction = lot.auction_title ?? "Cannon's Auction"

  const ogTitle = `${title} | James River Gooners`
  const ogDesc = [category, bid, bids, auction].filter(Boolean).join(' · ')
  const ogImage = (lot.images ?? [])[0] || `${spaOrigin}/og-image.png`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(ogTitle)}</title>
  <meta property="og:site_name" content="James River Gooners" />
  <meta property="og:title" content="${esc(ogTitle)}" />
  <meta property="og:description" content="${esc(ogDesc)}" />
  <meta property="og:url" content="${esc(spaUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="${esc(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(ogTitle)}" />
  <meta name="twitter:description" content="${esc(ogDesc)}" />
  <meta name="twitter:image" content="${esc(ogImage)}" />
  <script>window.location.replace(${JSON.stringify(spaUrl)})</script>
</head>
<body>
  <p><a href="${esc(spaUrl)}">View on James River Gooners →</a></p>
</body>
</html>`
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } })
    }

    const url = new URL(req.url)
    const itemParam = url.searchParams.get('item') ?? ''
    const colon = itemParam.indexOf(':')
    const spaOrigin = env.SPA_ORIGIN ?? 'https://gooners.anders.omg.lol'

    if (!itemParam || colon < 1) {
      return Response.redirect(spaOrigin, 302)
    }

    const auctionSafeId = itemParam.slice(0, colon)
    const itemId = itemParam.slice(colon + 1)
    const spaUrl = `${spaOrigin}/?item=${encodeURIComponent(itemParam)}`

    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return Response.redirect(spaUrl, 302)
    }

    const qs = new URLSearchParams({
      auction_safe_id: `eq.${auctionSafeId}`,
      item_id: `eq.${itemId}`,
      select: 'title,current_bid,final_bid,closed,total_bids,images,category,raw_category,auction_title',
      limit: '1',
    })

    let lot: LotRow | null = null
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/lots?${qs}`, {
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
      })
      if (res.ok) {
        const rows: LotRow[] = await res.json()
        lot = rows[0] ?? null
      }
    } catch {
      // fall through to redirect
    }

    if (!lot) {
      return Response.redirect(spaUrl, 302)
    }

    return new Response(buildHtml(lot, spaUrl, spaOrigin), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    })
  },
}
