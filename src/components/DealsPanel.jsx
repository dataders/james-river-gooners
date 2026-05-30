import { useMemo, useState } from 'react'
import { getCompMedianPrice, calcMaxBid, COST_MULTIPLIER, DEFAULT_MARGIN } from '../utils/roiCalc'
import { timeRemaining } from '../utils/time'

const HOUR_OPTIONS = [
  { label: '24h', value: 24 },
  { label: '48h', value: 48 },
  { label: '72h', value: 72 },
  { label: 'All', value: Infinity },
]

function hoursUntil(endDate) {
  if (!endDate) return Infinity
  const end = new Date(endDate.replace(/-/g, '/'))
  return Math.max(0, (end - new Date()) / 3600000)
}

function buildDeal(item, itemComps) {
  const median = getCompMedianPrice(itemComps)
  if (median == null || median === 0) return null
  const maxBid = calcMaxBid(median, DEFAULT_MARGIN)
  const allIn = Math.round(maxBid * COST_MULTIPLIER)
  const margin = 1 - (item.currentBid * COST_MULTIPLIER) / median
  if (margin < 0) return null
  return { median: Math.round(median), maxBid: Math.round(maxBid), allIn, margin }
}

export function DealsPanel({ items, allComps, onItemClick }) {
  const [maxHours, setMaxHours] = useState(48)

  const deals = useMemo(() => {
    return items
      .filter(item => {
        const h = hoursUntil(item.endDate)
        return maxHours === Infinity ? h >= 0 : h >= 0 && h <= maxHours
      })
      .flatMap(item => {
        const itemComps = allComps[item.auctionSafeId]?.[item.id]
        const deal = buildDeal(item, itemComps)
        return deal ? [{ item, ...deal }] : []
      })
      .sort((a, b) => b.margin - a.margin)
  }, [items, allComps, maxHours])

  return (
    <div className="deals-panel">
      <div className="deals-panel-controls">
        <span className="deals-panel-label">Closing within</span>
        <div className="deals-hours-pills">
          {HOUR_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`deals-hours-pill${maxHours === opt.value ? ' active' : ''}`}
              onClick={() => setMaxHours(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <span className="deals-panel-count">{deals.length} deal{deals.length !== 1 ? 's' : ''}</span>
      </div>

      {deals.length === 0 ? (
        <div className="deals-empty">
          No deals with eBay comps found closing in this window.
        </div>
      ) : (
        <div className="deals-list">
          {deals.map(({ item, median, maxBid, allIn, margin }) => (
            <DealCard
              key={item.id}
              item={item}
              median={median}
              maxBid={maxBid}
              allIn={allIn}
              margin={margin}
              onItemClick={onItemClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DealCard({ item, median, maxBid, allIn, margin, onItemClick }) {
  const imgSrc = item.images?.[0] || null
  const remaining = timeRemaining(item.endDate)
  const marginPct = Math.round(margin * 100)
  const clickable = typeof onItemClick === 'function'
  const open = () => clickable && onItemClick(item)

  return (
    <div
      className={`deal-card${clickable ? ' deal-card--clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={open}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') open() } : undefined}
    >
      <div className="deal-card-image">
        {imgSrc ? (
          <img src={imgSrc} alt={item.title} loading="lazy" />
        ) : (
          <div className="item-placeholder">{item.title}</div>
        )}
      </div>
      <div className="deal-card-body">
        <div className="deal-card-top">
          <div className="deal-card-title">{item.title}</div>
          <span className={`deal-margin-badge${marginPct >= 30 ? ' great' : marginPct >= 20 ? ' ok' : ''}`}>
            {marginPct}%
          </span>
        </div>
        <div className="item-category">{item.rawCategory || item.category}</div>
        <div className="deal-metrics">
          <div className="deal-metric">
            <span className="deal-metric-label">Current bid</span>
            <span className="deal-metric-value">${item.currentBid.toLocaleString()}</span>
          </div>
          <div className="deal-metric">
            <span className="deal-metric-label">eBay value</span>
            <span className="deal-metric-value">${median.toLocaleString()}</span>
          </div>
          <div className="deal-metric">
            <span className="deal-metric-label">Max bid</span>
            <span className="deal-metric-value deal-metric-value--highlight">${maxBid.toLocaleString()}</span>
          </div>
          <div className="deal-metric">
            <span className="deal-metric-label">All-in cost</span>
            <span className="deal-metric-value">${allIn.toLocaleString()}</span>
          </div>
        </div>
        <div className="deal-card-footer">
          {remaining && <span className="item-time">{remaining}</span>}
          <a
            href={item.detailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="deal-cannons-link"
            onClick={(e) => e.stopPropagation()}
          >
            View on Cannon's
          </a>
        </div>
      </div>
    </div>
  )
}
