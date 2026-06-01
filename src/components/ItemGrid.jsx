import { useState, useEffect, useRef, useCallback } from 'react'
import Masonry from 'react-masonry-css'
import { ItemCard } from './ItemCard'

const BATCH_SIZE = 50
// Keep at most this many cards in the DOM at once. When the user scrolls forward
// past the cap, we drop the oldest items and add a top spacer so the scroll
// position remains correct.
const MAX_DOM_ITEMS = 300

const breakpointColumns = {
  default: 4,
  1200: 3,
  800: 2,
}

// Rough per-item height estimate used for the top spacer. Auction cards are
// typically 300-450 px tall; 380 px splits the difference. We divide by column
// count because masonry stacks items vertically within each column.
const ITEM_HEIGHT_ESTIMATE = 380
const ITEM_GAP = 12

function estimateColumnHeight(itemCount, numCols) {
  const itemsPerCol = Math.ceil(itemCount / numCols)
  return itemsPerCol > 0 ? itemsPerCol * (ITEM_HEIGHT_ESTIMATE + ITEM_GAP) - ITEM_GAP : 0
}

function currentNumCols() {
  const w = window.innerWidth
  if (w <= 800) return 2
  if (w <= 1200) return 3
  return 4
}

export function ItemGrid({ items, allComps = {}, isFavorite, onToggleFavorite, onItemClick }) {
  // Pair `items` with its loaded count so we can reset loaded when items changes.
  const [loadState, setLoadState] = useState({ items, loaded: BATCH_SIZE })
  const sentinelRef = useRef(null)

  // Derive loaded count: reset to BATCH_SIZE if the items reference changed.
  const loaded = loadState.items === items ? loadState.loaded : BATCH_SIZE

  const observerCallback = useCallback((entries) => {
    if (entries[0].isIntersecting) {
      setLoadState(prev => {
        const current = prev.items === items ? prev.loaded : BATCH_SIZE
        return { items, loaded: Math.min(current + BATCH_SIZE, items.length) }
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

  const clampedLoaded = Math.min(loaded, items.length)
  const windowStart = Math.max(0, clampedLoaded - MAX_DOM_ITEMS)
  const visibleItems = items.slice(windowStart, clampedLoaded)

  // Compensate for items dropped from the top of the DOM window.
  const topSpacerHeight = windowStart > 0
    ? estimateColumnHeight(windowStart, currentNumCols())
    : 0

  return (
    <div className="item-grid-wrapper">
      <div className="item-count">
        {items.length} items{clampedLoaded < items.length ? ` (showing ${clampedLoaded})` : ''}
      </div>
      {topSpacerHeight > 0 && (
        <div className="scroll-top-spacer" style={{ height: topSpacerHeight }} />
      )}
      <Masonry
        breakpointCols={breakpointColumns}
        className="masonry-grid"
        columnClassName="masonry-column"
      >
        {visibleItems.map(item => (
          <ItemCard
            key={`${item.auctionSafeId}:${item.id}`}
            item={item}
            itemComps={allComps[item.auctionSafeId]?.[item.id]}
            isFavorite={isFavorite(item)}
            onToggleFavorite={onToggleFavorite}
            onItemClick={onItemClick}
          />
        ))}
      </Masonry>
      {clampedLoaded < items.length && (
        <div ref={sentinelRef} className="scroll-sentinel" />
      )}
    </div>
  )
}
