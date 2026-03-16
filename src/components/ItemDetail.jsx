import { useState, useEffect } from 'react'
import { timeRemaining } from '../utils/time'

export function ItemDetail({ item, onClose }) {
  const [imgIndex, setImgIndex] = useState(0)

  // Reset image index when item changes
  useEffect(() => {
    setImgIndex(0)
  }, [item?.id])

  // Close on Escape
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  if (!item) return null

  const images = item.images || []
  const remaining = timeRemaining(item.endDate)

  const prev = () => setImgIndex(i => (i - 1 + images.length) % images.length)
  const next = () => setImgIndex(i => (i + 1) % images.length)

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <button className="detail-close" onClick={onClose} aria-label="Close">&times;</button>

        {images.length > 0 && (
          <div className="detail-carousel">
            <img src={images[imgIndex]} alt={item.title} />
            {images.length > 1 && (
              <>
                <button className="carousel-prev" onClick={prev}>&lsaquo;</button>
                <button className="carousel-next" onClick={next}>&rsaquo;</button>
                <div className="carousel-dots">
                  {images.map((_, i) => (
                    <span
                      key={i}
                      className={`carousel-dot${i === imgIndex ? ' active' : ''}`}
                      onClick={() => setImgIndex(i)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className="detail-body">
          <h2 className="detail-title">{item.title}</h2>
          <div className="detail-category">{item.rawCategory || item.category}</div>

          <div className="detail-bid-row">
            <span className="detail-bid">${item.currentBid.toLocaleString()}</span>
            <span className="detail-bids">{item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}</span>
          </div>

          {remaining && <div className="detail-time">{remaining}</div>}

          {item.description && (
            <div className="detail-description">{item.description}</div>
          )}

          {item.detailUrl && (
            <a
              href={item.detailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="detail-link"
            >
              Open on Cannon's
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
