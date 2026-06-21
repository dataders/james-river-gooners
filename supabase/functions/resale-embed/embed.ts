// Pure helpers for resale-embed. Text embedding normalization + RPC row mappers
// to the camelCase shapes EbayComps/CannonsComps consume.
const HF_MODEL = 'nomic-ai/nomic-embed-text-v1.5'

export function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm > 0 ? v.map(x => x / norm) : v
}

// Embed a text query exactly as embed-query does (search_query prefix, L2-norm).
export async function embedText(query: string, hfToken: string): Promise<number[]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (hfToken) headers['Authorization'] = `Bearer ${hfToken}`
  const res = await fetch(
    `https://api-inference.huggingface.co/pipeline/feature-extraction/${HF_MODEL}`,
    { method: 'POST', headers, body: JSON.stringify({ inputs: `search_query: ${query}` }),
      signal: AbortSignal.timeout(20_000) },
  )
  if (!res.ok) throw new Error(`HF ${res.status}: ${await res.text()}`)
  let emb: number[] | number[][] = await res.json()
  if (Array.isArray(emb[0])) emb = (emb as number[][])[0]
  return l2normalize(emb as number[])
}

export function mapSoldListingRows(rows: any[]) {
  return (rows || []).map(r => ({
    ebayItemId: r.ebay_item_id,
    similarity: r.similarity,
    title: r.title,
    price: { value: r.sold_price, currency: 'USD' },
    soldDate: r.sold_date,
    soldDateLabel: r.sold_date_label,
    condition: r.condition,
    thumbnailUrl: r.thumbnail_url,
    itemWebUrl: r.item_web_url,
  }))
}

export function mapCannonsRows(rows: any[]) {
  return (rows || []).map(r => ({
    itemId: r.comp_item_id,
    similarity: r.similarity,
    title: r.title,
    soldPrice: r.sold_price,
    soldDate: r.sold_at,
    thumbnailUrl: r.image_url,
    detailUrl: r.detail_url,
    auctionTitle: r.auction_title,
    source: r.source,
  }))
}
