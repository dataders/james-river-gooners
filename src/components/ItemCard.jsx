import { timeRemaining } from '../utils/time'

export function ItemCard({ item, onItemClick }) {
  const imgSrc = item.images?.[0] || null
  const remaining = timeRemaining(item.endDate)

  return (
    <div
      role="button"
      tabIndex={0}
      className="item-card"
      onClick={() => onItemClick(item)}
      onKeyDown={(e) => { if (e.key === 'Enter') onItemClick(item) }}
    >
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
          <span className="item-bids">{item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}</span>
        </div>
        {remaining && <div className="item-time">{remaining}</div>}
      </div>
    </div>
  )
}
