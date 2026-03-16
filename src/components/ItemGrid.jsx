import { useState, useEffect, useRef, useCallback } from 'react'
import Masonry from 'react-masonry-css'
import { ItemCard } from './ItemCard'

const BATCH_SIZE = 50

const breakpointColumns = {
  default: 4,
  1200: 3,
  800: 2,
}

export function ItemGrid({ items, onItemClick }) {
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE)
  const sentinelRef = useRef(null)

  // Reset visible count when items change (filter/search)
  useEffect(() => {
    setVisibleCount(BATCH_SIZE)
  }, [items])

  // Intersection observer for infinite scroll
  const observerCallback = useCallback((entries) => {
    if (entries[0].isIntersecting) {
      setVisibleCount(prev => Math.min(prev + BATCH_SIZE, items.length))
    }
  }, [items.length])

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
          <ItemCard key={item.id} item={item} onItemClick={onItemClick} />
        ))}
      </Masonry>
      {visibleCount < items.length && (
        <div ref={sentinelRef} className="scroll-sentinel" />
      )}
    </div>
  )
}
