// Pure SoldComps helpers for the resale-ebay edge function. Keyword-query only
// (no build_ebay_sold_searches funnel). Output matches the UI's camelCase shape
// (price: {value, currency}) consumed by src/utils/ebayComps.js normalizeEbaySoldMatches.
const ITEM_URL_RE = /ebay\.com\/itm\/(\d+)/

export function buildSoldcompsParams(query: string, categoryId?: string): Record<string, string> {
  const params: Record<string, string> = { keyword: query }
  if (categoryId) params.categoryId = categoryId
  return params
}

function text(v: unknown, fallback = ''): string {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return fallback
}

export interface CompRow {
  ebayItemId: string
  title: string
  price: { value: string; currency: string }
  soldDate: string
  soldDateLabel: string
  thumbnailUrl: string
  itemWebUrl: string
  condition: string
}

export function parseSoldcompsItems(items: unknown[]): CompRow[] {
  const out: CompRow[] = []
  const seen = new Set<string>()
  for (const raw of items || []) {
    if (!raw || typeof raw !== 'object') continue
    const it = raw as Record<string, unknown>
    const url = text(it.url ?? it.itemUrl ?? it.itemWebUrl)
    const title = text(it.title)
    const priceValue = text(it.soldPrice ?? it.price ?? it.priceValue)
    if (!url || !title || !priceValue) continue
    if (seen.has(url)) continue
    seen.add(url)
    const ended = text(it.endedAt ?? it.soldAt ?? it.soldDate)
    out.push({
      ebayItemId: text(it.itemId ?? it.ebayItemId) || (url.match(ITEM_URL_RE)?.[1] ?? ''),
      title,
      price: { value: priceValue, currency: text(it.soldCurrency ?? it.currency, 'USD') },
      soldDate: ended,
      soldDateLabel: ended ? new Date(ended).toLocaleDateString() : '',
      thumbnailUrl: text(it.imageUrl ?? it.thumbnailUrl ?? it.image),
      itemWebUrl: url,
      condition: text(it.condition),
    })
  }
  return out
}

export type ScanStatus = 'ok' | 'over_cap' | 'live_error' | 'no_results'

export function decideStatus(httpStatus: number, rows: unknown[]): ScanStatus {
  if (httpStatus >= 400) return 'live_error'
  return rows.length > 0 ? 'ok' : 'no_results'
}
