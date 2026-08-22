// @ts-nocheck
import { isDisplayConfidence } from './enrichment.js'

const EBAY_SEARCH_URL = 'https://www.ebay.com/sch/i.html'

// Mirrors ebay_category_ids.yml — Cannon's broad group → eBay L1 categoryId.
// Used to scope the "Search eBay" browse link to the right department.
const EBAY_CATEGORY_IDS = {
  'Art': '550',
  'China & Glass': '870',
  'Collectibles': '1',
  'Coins & Currency': '11116',
  'Jewelry & Watches': '281',
  'Silver & Metal': '20081',
  'Furniture': '11700',
  'Home & Kitchen': '11700',
  'Lawn & Garden': '11700',
  'Fashion': '11450',
  'Toys & Games': '220',
  'Books & Media': '267',
  'Sporting Goods': '888',
  'Electronics': '293',
  'Industrial & Equipment': '12576',
  'Stamps': '260',
}

function ebayCategoryId(item) {
  const group = (item && item.category) || ''
  return EBAY_CATEGORY_IDS[group] || ''
}

const STOP_WORDS = new Set([
  'and',
  'as',
  'barrel',
  'cal',
  'caliber',
  'condition',
  'for',
  'includes',
  'including',
  'is',
  'lot',
  'measure',
  'measures',
  'missing',
  'model',
  'neither',
  'number',
  'please',
  'preview',
  'remote',
  'remotes',
  'serial',
  'shot',
  'sold',
  'the',
  'this',
  'used',
  'with',
  'working',
])

const RESTRICTED_CATEGORIES = new Set(['Firearms'])

function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function cleanCompText(rawText) {
  return normalizeSpaces(
    (rawText || '')
      .replace(/\bserial\s+number\b.*$/i, '')
      .replace(/\bthis is a used firearm\b.*$/i, '')
      .replace(/\bplease preview\b.*$/i, '')
      .replace(/\bmeasures?\b.*$/i, '')
      .replace(/[“”]/g, '"')
      .replace(/[^\w\s".'-]/g, ' ')
  )
}

export function compactItemText(item) {
  const text = [
    item.description,
    item.title && !/^lot\s*-/i.test(item.title) ? item.title : '',
    item.rawCategory,
  ].filter(Boolean).join(' ')

  return cleanCompText(text)
}

// Quoted exact-phrase query from the lot's most descriptive contiguous text —
// its real title, or the description when the title is a "Lot - N" placeholder.
// eBay treats double quotes in _nkw as an exact-phrase match, so this is the
// precise primary query; the token-bag queries stay as fallbacks. Returns ''
// when there's no usable multi-word phrase. Mirrors item_exact_phrase in
// scraper/ebay_comps.py — keep the two in sync.
export function itemExactPhrase(item, maxWords = 6) {
  const title = item.title || ''
  const source = title.trim() && !/^lot\s*-/i.test(title) ? title : (item.description || '')
  const words = cleanCompText(source).split(' ').filter(Boolean).slice(0, maxWords)
  if (words.length < 2) return ''
  return `"${words.join(' ')}"`
}

function meaningfulTokens(text) {
  return normalizeSpaces(text)
    .split(' ')
    .map(token => token.replace(/^[-'"`]+|[-'"`]+$/g, ''))
    .filter(Boolean)
    .filter(token => !STOP_WORDS.has(token.toLowerCase()))
}

function dedupeWords(words) {
  const seen = new Set()
  return words.filter(word => {
    const key = word.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildEbaySoldSearchUrl(query, { categoryId = '' } = {}) {
  const params = new URLSearchParams({
    _nkw: query,
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13',
    LH_ItemLocation: '1',
  })
  if (categoryId && categoryId !== '0') params.set('_sacat', categoryId)
  return `${EBAY_SEARCH_URL}?${params.toString()}`
}

export function getEbayCompKey(item) {
  return `${item.auctionSafeId || ''}:${item.id}`
}

export function isEbayItemUrl(value) {
  if (!value) return false

  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    if (hostname !== 'ebay.com' && !hostname.endsWith('.ebay.com')) return false

    const segments = url.pathname.split('/').filter(Boolean)
    const itemIndex = segments.indexOf('itm')
    if (itemIndex < 0) return false

    return segments.slice(itemIndex + 1).some(segment => /^\d{9,}$/.test(segment))
  } catch {
    return false
  }
}

function formatSoldCompPrice(comp) {
  if (comp.soldPrice) return comp.soldPrice
  if (!comp.price?.value) return ''

  const value = Number(comp.price.value)
  if (comp.price.currency === 'USD' && Number.isFinite(value)) {
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }

  return `${comp.price.value} ${comp.price.currency || ''}`.trim()
}

export function normalizeEbaySoldMatches(soldComps) {
  return (soldComps?.matches || soldComps?.results || [])
    .map(comp => ({
      ...comp,
      priceLabel: formatSoldCompPrice(comp),
      dateLabel: comp.soldDateLabel || comp.soldDate || '',
      thumbnailUrl: comp.thumbnailUrl || comp.imageUrl || '',
      itemWebUrl: comp.itemWebUrl || comp.url || '',
      shippingLabel: comp.shippingLabel || comp.shipping || '',
    }))
    .filter(comp => (
      comp.title &&
      comp.priceLabel &&
      isEbayItemUrl(comp.itemWebUrl)
    ))
}

export function hasEbayComps(soldComps) {
  return normalizeEbaySoldMatches(soldComps).length > 0
}

// Reshape flat `public_auction_comps` rows (Supabase, issue #6) into the same
// `{ [itemId]: { status, query, searchUrl, fetchedAt, warning, matches: [...] } }`
// shape the static read model produces, so EbayComps consumes either source
// unchanged. Each view row is one matched eBay listing; rows for the same item
// share its attempt-level fields, so the first row seen sets them and every row
// contributes a match. Rows are ordered newest-first within the array.
export function groupSupabaseComps(rows) {
  const items = {}
  for (const row of rows || []) {
    const itemId = row.item_id
    if (!itemId) continue
    let entry = items[itemId]
    if (!entry) {
      entry = {
        status: row.status || 'ok',
        query: row.query || '',
        searchUrl: row.search_url || '',
        fetchedAt: row.fetched_at || '',
        warning: row.warning || null,
        matches: [],
      }
      items[itemId] = entry
    }
    const match = {
      ebayItemId: row.ebay_item_id || null,
      title: row.title || '',
      price: { value: row.price_value, currency: row.price_currency || 'USD' },
      shippingLabel: row.shipping_label || null,
      soldDate: row.sold_date || null,
      soldDateLabel: row.sold_date_label || null,
      thumbnailUrl: row.thumbnail_url || null,
      itemWebUrl: row.item_web_url || '',
      condition: row.condition || null,
      sourceQuery: row.source_query || null,
      matchConfidence: row.match_confidence || null,
    }
    entry.matches.push(match)
  }
  // Hybrid (embedding-ranked) comps are higher quality than keyword matches.
  // Sort them first so EbayComps always shows the embedding top-K when available,
  // falling back to keyword comps only when no hybrid comps exist yet. Then
  // deduplicate by eBay listing ID so the same listing doesn't appear twice when
  // it surfaces in both the keyword and hybrid result sets.
  for (const entry of Object.values(items)) {
    entry.matches.sort((a, b) =>
      (a.sourceQuery === 'hybrid' ? 0 : 1) - (b.sourceQuery === 'hybrid' ? 0 : 1)
    )
    const seen = new Set()
    entry.matches = entry.matches.filter(m => {
      const key = m.ebayItemId
      if (!key) return true
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return items
}

export function getEbayCompThumbnail(comp) {
  // Only ever show the comp's own eBay photo. Never fall back to the auction
  // item's image — doing so made every comp appear to show the Cannon's lot
  // photo instead of the actual eBay listing. When no eBay thumbnail was
  // captured, callers render a placeholder instead.
  return comp?.thumbnailUrl || ''
}

export function buildEbaySoldSearches(item) {
  const text = compactItemText(item)
  const tokens = meaningfulTokens(text)
  const modelTokens = tokens.filter(token => (
    /[A-Za-z]\d|\d[A-Za-z]|[-/]\d/.test(token) && token.length >= 4
  ))

  const broadTokens = tokens.filter(token => !/^\d+$/.test(token)).slice(0, 7)
  const specificTokens = dedupeWords([...tokens.slice(0, 4), ...modelTokens]).slice(0, 8)
  const categoryTokens = meaningfulTokens(`${item.rawCategory || item.category || ''} ${text}`).slice(0, 7)

  // Primary query prefers the AI-derived `searchQuery` (brand + model + type +
  // a key attribute — the best eBay sold-listing phrase, mirroring the backend's
  // ebay_query.enriched_exact_phrase) when the lot is confidently identified.
  // It's unquoted so eBay AND-matches the terms. Falls back to the lot's quoted
  // exact phrase, then the token bag, when there's no trustworthy enrichment.
  const enrichedQuery = isDisplayConfidence(item) ? (item.searchQuery || '').trim() : ''
  const specificQuery = enrichedQuery || itemExactPhrase(item) || specificTokens.join(' ')

  const candidates = [
    {
      kind: 'specific',
      label: 'Specific match',
      query: specificQuery,
    },
    {
      kind: 'broad',
      label: 'Broader match',
      query: broadTokens.join(' '),
    },
    {
      kind: 'category',
      label: 'Category match',
      query: dedupeWords(categoryTokens).join(' '),
    },
  ].filter(candidate => candidate.query.length > 0)

  const seen = new Set()
  const warning = RESTRICTED_CATEGORIES.has(item.category)
    ? 'eBay may return limited results for restricted categories.'
    : ''

  const categoryId = ebayCategoryId(item)

  return candidates.filter(candidate => {
    const key = candidate.query.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(candidate => ({
    ...candidate,
    url: buildEbaySoldSearchUrl(
      candidate.query,
      { categoryId: candidate.kind === 'specific' ? categoryId : '' },
    ),
    warning,
  }))
}
