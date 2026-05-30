const EBAY_SEARCH_URL = 'https://www.ebay.com/sch/i.html'

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

export function compactItemText(item) {
  const text = [
    item.description,
    item.title && !/^lot\s*-/i.test(item.title) ? item.title : '',
    item.rawCategory,
  ].filter(Boolean).join(' ')

  return normalizeSpaces(
    text
      .replace(/\bserial\s+number\b.*$/i, '')
      .replace(/\bthis is a used firearm\b.*$/i, '')
      .replace(/\bplease preview\b.*$/i, '')
      .replace(/\bmeasures?\b.*$/i, '')
      .replace(/[“”]/g, '"')
      .replace(/[^\w\s".'-]/g, ' ')
  )
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

export function buildEbaySoldSearchUrl(query) {
  const params = new URLSearchParams({
    _nkw: query,
    LH_Sold: '1',
    LH_Complete: '1',
    _sop: '13',
  })
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

  const candidates = [
    {
      kind: 'specific',
      label: 'Specific match',
      query: specificTokens.join(' '),
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

  return candidates.filter(candidate => {
    const key = candidate.query.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(candidate => ({
    ...candidate,
    url: buildEbaySoldSearchUrl(candidate.query),
    warning,
  }))
}
