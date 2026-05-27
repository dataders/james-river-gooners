import { useState, useEffect, useRef, useCallback } from 'react'
import Masonry from 'react-masonry-css'
import { ItemCard } from './ItemCard'

const BATCH_SIZE = 50

const breakpointColumns = {
  default: 4,
  1200: 3,
  800: 2,
}

export function ItemGrid({ items, isFavorite, onToggleFavorite, onItemClick }) {
  const [visibleState, setVisibleState] = useState({ items, visibleCount: BATCH_SIZE })
  const sentinelRef = useRef(null)

  const visibleCount = visibleState.items === items ? visibleState.visibleCount : BATCH_SIZE

  // Intersection observer for infinite scroll
  const observerCallback = useCallback((entries) => {
    if (entries[0].isIntersecting) {
      setVisibleState(prev => {
        const currentCount = prev.items === items ? prev.visibleCount : BATCH_SIZE
        return {
          items,
          visibleCount: Math.min(currentCount + BATCH_SIZE, items.length),
        }
      })
    }
  }, [items])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(observerCallback, {
      rootMargin: '200px',
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [observerCallback])

  const visibleItems = items.slice(0, visibleCount)

  return (
    <div className="item-grid-wrapper">
      <div className="item-count">
        {items.length} items{visibleCount < items.length ? ` (showing ${visibleCount})` : ''}
      </div>
      <Masonry
        breakpointCols={breakpointColumns}
        className="masonry-grid"
        columnClassName="masonry-column"
      >
        {visibleItems.map(item => (
          <ItemCard
            key={`${item.auctionSafeId}:${item.id}`}
            item={item}
            isFavorite={isFavorite(item)}
            onToggleFavorite={onToggleFavorite}
            onItemClick={onItemClick}
          />
        ))}
      </Masonry>
      {visibleCount < items.length && (
        <div ref={sentinelRef} className="scroll-sentinel" />
      )}
    </div>
  )
}
