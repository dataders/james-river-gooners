import { memo } from 'react'
import { itemTimeRemaining } from '../utils/time'
import { getCompMedianPrice, calcMaxBid, COST_MULTIPLIER, DEFAULT_MARGIN } from '../utils/roiCalc'
import { getDisplayEnrichment } from '../utils/enrichment'

export const ItemCard = memo(function ItemCard({ item, compact = false, itemComps, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onItemClick, bidStatus }) {
  const imgSrc = item.images?.[0] || null
  const remaining = itemTimeRemaining(item)
  const enrichment = getDisplayEnrichment(item)
  // "Lot - N" titles carry no detail (the lot's identity lives in the
  // description), so when we have a confident product name, show it as the
  // title instead and keep the lot number on the category line for reference.
  const usedLabelAsTitle = enrichment != null && /^lot\s*-/i.test(item.title || '')
  const displayTitle = usedLabelAsTitle ? enrichment.label : item.title

  const compMedian = getCompMedianPrice(itemComps)
  const maxBid = compMedian != null ? calcMaxBid(compMedian, DEFAULT_MARGIN) : null
  const totalCost = maxBid != null ? Math.round(maxBid * COST_MULTIPLIER) : null

  const toggleFavorite = (event) => {
    event.stopPropagation()
    onToggleFavorite(item)
  }

  const toggleIgnored = (event) => {
    event.stopPropagation()
    onToggleIgnored(item)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`item-card${compact ? ' compact' : ''}${isIgnored ? ' ignored' : ''}`}
      onClick={() => onItemClick(item)}
      onKeyDown={(e) => { if (e.key === 'Enter') onItemClick(item) }}
    >
      <button
        type="button"
        className={`ignore-button${isIgnored ? ' active' : ''}`}
        aria-label={isIgnored ? 'Stop ignoring' : 'Not interested'}
        title={isIgnored ? 'Stop ignoring' : 'Not interested'}
        onClick={toggleIgnored}
      >
        ✕
      </button>
      <button
        type="button"
        className={`favorite-button${isFavorite ? ' active' : ''}`}
        aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}
        onClick={toggleFavorite}
      >
        {isFavorite ? '★' : '☆'}
      </button>
      <div className="item-image">
        {imgSrc ? (
          <img src={imgSrc} alt={item.title} loading="lazy" />
        ) : (
          <div className="item-placeholder">{item.title}</div>
        )}
      </div>
      <div className="item-info">
        <div className="item-title">{displayTitle}</div>
        {enrichment && (!usedLabelAsTitle || enrichment.condition) && (
          <div className="item-product">
            {!usedLabelAsTitle && <span className="item-product-label">{enrichment.label}</span>}
            {enrichment.condition && <span className="item-condition">{enrichment.condition}</span>}
          </div>
        )}
        <div className="item-category">
          {usedLabelAsTitle && item.lotNumber ? `Lot ${item.lotNumber} · ` : ''}
          {item.rawCategory || item.category}
        </div>
        {compact && item.description && (
          <div className="item-description">{item.description}</div>
        )}
        {bidStatus?.winning != null && (() => {
          const closed = item.closed || bidStatus.itemClosed
          return (
            <div className={`bid-status-badge${bidStatus.winning ? ' bid-status-winning' : ' bid-status-outbid'}`}>
              {bidStatus.winning
                ? (closed ? '✓ Won' : '✓ Winning')
                : (closed
                    ? `✗ Lost · $${bidStatus.currentBid != null ? bidStatus.currentBid.toLocaleString() : '?'}`
                    : `Outbid · $${bidStatus.currentBid != null ? bidStatus.currentBid.toLocaleString() : '?'}`)}
            </div>
          )
        })()}
        <div className="item-bid-row">
          <span className="item-bid">${(bidStatus?.currentBid ?? item.currentBid).toLocaleString()}</span>
          <span className="item-bids">
            {item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}
            {item.uniqueBidders > 0 && ` · ${item.uniqueBidders} bidder${item.uniqueBidders !== 1 ? 's' : ''}`}
          </span>
        </div>
        {maxBid != null && (
          <div className="item-roi-row">
            <span className="item-roi-max"><span className="item-roi-label">Max</span> ${Math.round(maxBid)}</span>
            <span className="item-roi-cost"><span className="item-roi-label">All-in</span> ${totalCost}</span>
          </div>
        )}
        {remaining && <div className="item-time">{remaining}</div>}
      </div>
    </div>
  )
})
