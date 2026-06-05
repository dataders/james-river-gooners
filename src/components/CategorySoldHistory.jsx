import { COST_MULTIPLIER } from '../utils/roiCalc'

function money(v) {
  return `$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

// Coarse "how long ago" for the most recent sale in this category.
function recency(iso) {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${Math.round(days / 365)}y ago`
}

// Cannon's per-category sold-price baseline (#95/#96): what lots in this category
// have historically sold for, so a lot with no close item-level comp still has a
// price signal. Complements the item-level "Sold previously" (CannonsComps) and
// eBay comps with a category-wide median + range. Renders nothing until stats
// for the category load.
export function CategorySoldHistory({ category, stats, currentBid }) {
  if (!stats || stats.medianSold <= 0) return null

  const range = stats.minSold != null && stats.maxSold != null
    ? `${money(stats.minSold)}–${money(stats.maxSold)}`
    : ''
  const recencyLabel = recency(stats.lastSoldAt)
  const profit = stats.medianSold - (currentBid || 0) * COST_MULTIPLIER
  const positive = profit >= 0

  return (
    <section className="category-sold-history">
      <div className="category-sold-header">
        <h3>Category sold history</h3>
        <span className="category-sold-median">median {money(stats.medianSold)}</span>
      </div>
      <div className="category-sold-meta">
        {[
          category,
          `${stats.soldCount.toLocaleString()} sold`,
          range && `range ${range}`,
          recencyLabel && `last ${recencyLabel}`,
        ].filter(Boolean).join(' · ')}
      </div>
      <div className={`category-sold-margin ${positive ? 'positive' : 'negative'}`}>
        At the current bid, est. {positive ? 'profit' : 'loss'} vs. category median:{' '}
        <strong>{money(Math.abs(profit))}</strong>
      </div>
    </section>
  )
}
