// @ts-check
/** @typedef {import('../types.ts').Item} Item */

/**
 * Maps our normalized condition to Facebook Marketplace condition values.
 * @param {string} condition
 * @returns {string}
 */
function mapCondition(condition) {
  if (condition === 'new') return 'New'
  if (condition === 'used') return 'Used - Good'
  return 'Used - Good'
}

/**
 * Escapes a value for CSV: wraps in quotes and escapes internal quotes.
 * @param {string|number|null|undefined} val
 * @returns {string}
 */
function csvCell(val) {
  if (val == null) return '""'
  const s = String(val).replace(/"/g, '""')
  return `"${s}"`
}

/**
 * Builds a suggested Marketplace listing title (≤100 chars).
 * @param {Item} item
 * @returns {string}
 */
function buildTitle(item) {
  const brand = item.brand || ''
  const model = item.modelOrSku || ''
  const base = [brand, model].filter(Boolean).join(' ') || item.title || ''
  return base.length > 100 ? base.slice(0, 97) + '…' : base
}

/**
 * Builds a listing description combining enrichment and raw description.
 * @param {Item} item
 * @returns {string}
 */
function buildDescription(item) {
  const lines = []
  if (item.brand && item.modelOrSku) lines.push(`${item.brand} ${item.modelOrSku}`)
  if (item.productType) lines.push(`Type: ${item.productType}`)
  if (item.condition) lines.push(`Condition: ${item.condition}`)
  if (item.description) lines.push('', item.description)
  lines.push('', `Source: ${item.detailUrl || ''}`)
  return lines.join('\n')
}

/**
 * Generates a CSV string formatted for Facebook Marketplace reference.
 * Columns follow the Facebook Commerce Manager catalog feed schema so sellers
 * can use the file as-is if they have a Shop, or as a posting reference.
 *
 * @param {Item[]} items
 * @returns {string}
 */
export function generateMarketplaceCsv(items) {
  const headers = [
    'id',
    'title',
    'description',
    'price',
    'currency',
    'condition',
    'availability',
    'category',
    'image_link',
    'additional_image_link',
    'link',
    'brand',
    'model',
  ]

  const rows = items.map(item => {
    const price = item.currentBid > 0 ? item.currentBid : ''
    const images = item.images || []
    return [
      csvCell(`${item.auctionSafeId}:${item.id}`),
      csvCell(buildTitle(item)),
      csvCell(buildDescription(item)),
      csvCell(price),
      csvCell('USD'),
      csvCell(mapCondition(item.condition || '')),
      csvCell('in stock'),
      csvCell(item.rawCategory || item.category || ''),
      csvCell(images[0] || ''),
      csvCell(images.slice(1, 10).join(',')),
      csvCell(item.detailUrl || ''),
      csvCell(item.brand || ''),
      csvCell(item.modelOrSku || ''),
    ].join(',')
  })

  return [headers.map(h => csvCell(h)).join(','), ...rows].join('\r\n')
}

/**
 * Triggers a CSV file download in the browser.
 * @param {string} csv
 * @param {string} filename
 */
export function downloadCsv(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
