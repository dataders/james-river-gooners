// @ts-nocheck
import { memo, useState, useRef } from 'react'
import { itemTimeRemaining } from '../utils/time'
import { getCompMedianPrice, calcMaxBid, COST_MULTIPLIER, DEFAULT_MARGIN } from '../utils/roiCalc'
import { getDisplayEnrichment } from '../utils/enrichment'
import { useFullImages } from '../hooks/useFullImages'

export const ItemCard = memo(function ItemCard({ item, compact = false, itemComps, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onItemClick, bidStatus }) {
  const remaining = itemTimeRemaining(item)
  const enrichment = getDisplayEnrichment(item)
  const usedLabelAsTitle = enrichment != null && /^lot\s*-/i.test(item.title || '')
  const displayTitle = usedLabelAsTitle ? enrichment.label : item.title

  const compMedian = getCompMedianPrice(itemComps)
  const maxBid = compMedian != null ? calcMaxBid(compMedian, DEFAULT_MARGIN) : null
  const totalCost = maxBid != null ? Math.round(maxBid * COST_MULTIPLIER) : null

  // Carousel state
  const [imgIndex, setImgIndex] = useState(0)
  const [fetchTriggered, setFetchTriggered] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [dragOffset, setDragOffset] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const touchStartRef = useRef(null)
  const didSwipeRef = useRef(false)

  // Reset carousel when this card slot is reused for a different item (virtualised grid).
  // Calling setState during render (guarded) is the React-approved way to reset derived
  // state on prop change — it avoids an extra render cycle compared to useEffect.
  const itemKey = `${item.auctionSafeId}:${item.id}`
  const [prevItemKey, setPrevItemKey] = useState(itemKey)
  if (prevItemKey !== itemKey) {
    setPrevItemKey(itemKey)
    setImgIndex(0)
    setFetchTriggered(false)
    setDragOffset(0)
    setIsDragging(false)
  }

  // Lazily fetched full image set (Supabase card views only carry images[0]).
  // useFullImages is reused here with triggered:false until first hover/touch.
  const images = useFullImages(item, { triggered: fetchTriggered })
  const clampedIndex = images.length > 0 ? Math.min(imgIndex, images.length - 1) : 0

  const hasMultiple = images.length > 1
  // Arrows visible on desktop hover only; dots + sliding carousel suppressed in compact (thumbnail row)
  const showArrows = !compact && hovered && hasMultiple
  const showDots = !compact && hasMultiple
  // Gallery badge: shown before first touch/hover (before we know if there are multiple images).
  // Replaced by dots once the user engages and images load.
  const showGalleryHint = !compact && !fetchTriggered

  const prevImage = (e) => {
    e.stopPropagation()
    setImgIndex(i => (i - 1 + images.length) % images.length)
  }
  const nextImage = (e) => {
    e.stopPropagation()
    setImgIndex(i => (i + 1) % images.length)
  }
  const goToImage = (e, i) => {
    e.stopPropagation()
    setImgIndex(i)
  }

  const handleMouseEnter = () => {
    setHovered(true)
    if (!fetchTriggered) setFetchTriggered(true)
  }

  const handleTouchStart = (e) => {
    const touch = e.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, t: Date.now() }
    didSwipeRef.current = false
    if (!fetchTriggered) setFetchTriggered(true)
  }

  const handleTouchMove = (e) => {
    if (!touchStartRef.current || images.length <= 1 || compact) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y
    // Only activate horizontal drag when clearly horizontal (suppress during vertical scroll)
    if (Math.abs(dx) > Math.abs(dy)) {
      // Rubber-band resistance at the first and last image
      let offset = dx
      if ((clampedIndex === 0 && dx > 0) || (clampedIndex === images.length - 1 && dx < 0)) {
        offset = dx / 3
      }
      setIsDragging(true)
      setDragOffset(offset)
    }
  }

  const handleTouchEnd = (e) => {
    if (!touchStartRef.current) return
    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y
    const dt = Date.now() - touchStartRef.current.t
    touchStartRef.current = null
    // Re-enable CSS transition before resetting position so the snap-to-image animates
    setIsDragging(false)
    setDragOffset(0)

    // Horizontal swipe: must be faster than 500ms, more horizontal than vertical
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 500 && images.length > 1) {
      didSwipeRef.current = true
      setImgIndex(i => {
        const n = images.length
        return dx < 0 ? Math.min(i + 1, n - 1) : Math.max(i - 1, 0)
      })
    }
  }

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
      onClick={() => {
        // Suppress the click that fires after a touch swipe
        if (didSwipeRef.current) {
          didSwipeRef.current = false
          return
        }
        onItemClick(item)
      }}
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
      <div
        className="item-image"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div
          className="carousel-track"
          style={hasMultiple ? {
            transform: `translateX(calc(-${clampedIndex * 100}% + ${dragOffset}px))`,
            transition: isDragging ? 'none' : 'transform 220ms ease',
          } : undefined}
        >
          {images.length > 0 ? images.map((src, i) => (
            <div key={i} className="carousel-slide">
              {!hasMultiple || Math.abs(i - clampedIndex) <= 1 ? (
                <img src={src} alt={item.title} loading="lazy" />
              ) : (
                <div className="carousel-slide-placeholder" />
              )}
            </div>
          )) : (
            <div className="carousel-slide">
              <div className="item-placeholder">{item.title}</div>
            </div>
          )}
        </div>
        {showArrows && (
          <>
            <button className="card-carousel-btn card-carousel-prev" onClick={prevImage} aria-label="Previous image">&lsaquo;</button>
            <button className="card-carousel-btn card-carousel-next" onClick={nextImage} aria-label="Next image">&rsaquo;</button>
          </>
        )}
        {showGalleryHint && (
          <div className="carousel-gallery-hint" aria-hidden="true">
            <svg viewBox="0 0 18 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14">
              <rect x="0.75" y="3.75" width="12.5" height="10.5" rx="1.25" stroke="currentColor" strokeWidth="1.5"/>
              <rect x="4.75" y="0.75" width="12.5" height="10.5" rx="1.25" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </div>
        )}
        {showDots && (
          <div className="card-carousel-dots">
            {images.map((_, i) => (
              <span
                key={i}
                role="button"
                aria-label={`Image ${i + 1}`}
                className={`card-carousel-dot${i === clampedIndex ? ' active' : ''}`}
                onClick={(e) => goToImage(e, i)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="item-info">
        <div className="item-title">{displayTitle}</div>
        {enrichment && (!usedLabelAsTitle || enrichment.condition || enrichment.isMixedLot || parseInt(enrichment.quantity, 10) > 1) && (
          <div className="item-product">
            {!usedLabelAsTitle && <span className="item-product-label">{enrichment.label}</span>}
            {enrichment.condition && <span className="item-condition">{enrichment.condition}</span>}
            {enrichment.isMixedLot && <span className="enrichment-badge enrichment-badge-mixed">Mixed lot</span>}
            {(() => {
              const qty = parseInt(enrichment.quantity, 10)
              return Number.isFinite(qty) && qty > 1
                ? <span className="enrichment-badge enrichment-badge-qty">Qty {qty}</span>
                : null
            })()}
          </div>
        )}
        {enrichment?.conditionFlags.length > 0 && (
          <div className="enrichment-flags">
            {enrichment.conditionFlags.map(flag => (
              <span key={flag} className="enrichment-flag" title="Resale-risk flag">⚠ {flag}</span>
            ))}
          </div>
        )}
        {enrichment?.keyAttributes.length > 0 && (
          <div className="enrichment-chips">
            {enrichment.keyAttributes.map(attr => (
              <span key={attr} className="enrichment-chip">{attr}</span>
            ))}
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
