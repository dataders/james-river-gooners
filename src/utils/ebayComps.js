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
