import { memo } from 'react'
import { timeRemaining } from '../utils/time'
import { getCompMedianPrice, calcMaxBid, COST_MULTIPLIER, DEFAULT_MARGIN } from '../utils/roiCalc'

export const ItemCard = memo(function ItemCard({ item, itemComps, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onItemClick }) {
  const imgSrc = item.images?.[0] || null
  const remaining = timeRemaining(item.endDate)

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
      className={`item-card${isIgnored ? ' ignored' : ''}`}
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
        <div className="item-title">{item.title}</div>
        <div className="item-category">{item.rawCategory || item.category}</div>
        <div className="item-bid-row">
          <span className="item-bid">${item.currentBid.toLocaleString()}</span>
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
