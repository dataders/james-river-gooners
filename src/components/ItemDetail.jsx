import { useState, useEffect } from 'react'
import { timeRemaining } from '../utils/time'
import { EbayComps } from './EbayComps'
import { RoiCalculator } from './RoiCalculator'

export function ItemDetail({ item, ebayComps = {}, isFavorite, onToggleFavorite, onClose }) {
  const [imageState, setImageState] = useState({ itemKey: null, imgIndex: 0 })
  const [copied, setCopied] = useState(false)

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }
  const itemKey = item ? `${item.auctionSafeId || ''}:${item.id}` : null

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
  const maxImgIndex = Math.max(images.length - 1, 0)
  const imgIndex = imageState.itemKey === itemKey
    ? Math.min(imageState.imgIndex, maxImgIndex)
    : 0
  const remaining = timeRemaining(item.endDate)

  const setCurrentImgIndex = (updater) => {
    setImageState(prevState => {
      const currentIndex = prevState.itemKey === itemKey
        ? Math.min(prevState.imgIndex, maxImgIndex)
        : 0
      const rawIndex = typeof updater === 'function' ? updater(currentIndex) : updater
      const nextIndex = Math.max(0, Math.min(rawIndex, maxImgIndex))
      return { itemKey, imgIndex: nextIndex }
    })
  }

  const prev = () => setCurrentImgIndex(i => (i - 1 + images.length) % images.length)
  const next = () => setCurrentImgIndex(i => (i + 1) % images.length)

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
                      onClick={() => setCurrentImgIndex(i)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className="detail-body">
          <div className="detail-title-row">
            <h2 className="detail-title">{item.title}</h2>
            <button
              type="button"
              className={`favorite-button detail-favorite${isFavorite ? ' active' : ''}`}
              aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}
              onClick={() => onToggleFavorite(item)}
            >
              {isFavorite ? '★' : '☆'}
            </button>
          </div>
          <div className="detail-category">{item.rawCategory || item.category}</div>

          <div className="detail-bid-row">
            <span className="detail-bid">${item.currentBid.toLocaleString()}</span>
            <span className="detail-bids">{item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}</span>
          </div>

          {remaining && <div className="detail-time">{remaining}</div>}

          {item.description && (
            <div className="detail-description">{item.description}</div>
          )}

          <div className="detail-actions">
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
            <button className="detail-copy-link" onClick={handleCopyLink}>
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>

          <RoiCalculator soldComps={ebayComps[item.id]} />
          <EbayComps item={item} soldComps={ebayComps[item.id]} />
        </div>
      </div>
    </div>
  )
}
