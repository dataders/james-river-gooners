function timeRemaining(endDate) {
  if (!endDate) return ''
  const end = new Date(endDate.replace(/-/g, '/'))
  const now = new Date()
  const diff = end - now
  if (diff <= 0) return 'Ended'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  if (days > 0) return `${days}d ${hours}h`
  const mins = Math.floor((diff % 3600000) / 60000)
  return `${hours}h ${mins}m`
}

export function ItemCard({ item }) {
  const imgSrc = item.images?.[0] || null
  const remaining = timeRemaining(item.endDate)

  return (
    <a
      href={item.detailUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="item-card"
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
        <div className="item-category">{item.category}</div>
        <div className="item-bid-row">
          <span className="item-bid">${item.currentBid.toLocaleString()}</span>
          <span className="item-bids">{item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}</span>
        </div>
        {remaining && <div className="item-time">{remaining}</div>}
      </div>
    </a>
  )
}
