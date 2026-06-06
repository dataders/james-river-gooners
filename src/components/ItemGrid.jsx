import { useState, useEffect, useRef, useCallback } from 'react'
import Masonry from 'react-masonry-css'
import { ItemCard } from './ItemCard'

const BATCH_SIZE = 50
// Keep at most this many cards in the DOM at once. When the user scrolls forward
// past the cap, we drop the oldest items and add a top spacer so the scroll
// position remains correct.
const MAX_DOM_ITEMS = 300

// Column count is derived from the grid's *actual* container width (via a
// ResizeObserver) rather than window.innerWidth. Keying off the window was the
// source of repeated laptop overflow (#84, #110): the ~280px sidebar + padding
// mean the usable grid width trails the window by ~350px, so a window-based
// breakpoint would pick one column too many and push the last card off-screen.
const ITEM_GAP = 12
const MIN_CARD_WIDTH = 280  // target minimum card width before adding a column
const MAX_COLS = 5

function colsForWidth(width) {
  if (!width || width <= 0) return 1
  // Most columns N whose card width (width - (N-1)*gap)/N stays ≥ MIN_CARD_WIDTH.
  const n = Math.floor((width + ITEM_GAP) / (MIN_CARD_WIDTH + ITEM_GAP))
  return Math.max(1, Math.min(MAX_COLS, n))
}

// Rough per-item height estimate used for the top spacer. Auction cards are
// typically 300-450 px tall; 380 px splits the difference. We divide by column
// count because masonry stacks items vertically within each column.
const ITEM_HEIGHT_ESTIMATE = 380
// Compact rows are a single fixed-height list, so they estimate much shorter.
const COMPACT_ITEM_HEIGHT = 132

function estimateColumnHeight(itemCount, numCols, itemHeight = ITEM_HEIGHT_ESTIMATE) {
  const itemsPerCol = Math.ceil(itemCount / numCols)
  return itemsPerCol > 0 ? itemsPerCol * (itemHeight + ITEM_GAP) - ITEM_GAP : 0
}

export function ItemGrid({ items, compact = false, allComps = {}, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onItemClick, bidStatuses }) {
  // Pair `items` with its loaded count so we can reset loaded when items changes.
  const [loadState, setLoadState] = useState({ items, loaded: BATCH_SIZE })
  const sentinelRef = useRef(null)
  const wrapperRef = useRef(null)
  const [numCols, setNumCols] = useState(3)

  // Track the grid's actual width so the column count never overruns the
  // available space (the sidebar makes window.innerWidth unreliable here).
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const update = () => setNumCols(colsForWidth(wrapper.clientWidth))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

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

  // Compact mode is a single-column list; the masonry grid uses its derived
  // column count. The top spacer estimate follows the active layout.
  const effectiveCols = compact ? 1 : numCols

  // Compensate for items dropped from the top of the DOM window.
  const topSpacerHeight = windowStart > 0
    ? estimateColumnHeight(windowStart, effectiveCols, compact ? COMPACT_ITEM_HEIGHT : ITEM_HEIGHT_ESTIMATE)
    : 0

  const cards = visibleItems.map(item => (
    <ItemCard
      key={`${item.auctionSafeId}:${item.id}`}
      item={item}
      compact={compact}
      itemComps={allComps[item.auctionSafeId]?.[item.id]}
      isFavorite={isFavorite(item)}
      onToggleFavorite={onToggleFavorite}
      isIgnored={isIgnored(item)}
      onToggleIgnored={onToggleIgnored}
      onItemClick={onItemClick}
      bidStatus={bidStatuses?.get(String(item.id))}
    />
  ))

  return (
    <div className="item-grid-wrapper" ref={wrapperRef}>
      <div className="item-count">
        {items.length} items{clampedLoaded < items.length ? ` (showing ${clampedLoaded})` : ''}
      </div>
      {topSpacerHeight > 0 && (
        <div className="scroll-top-spacer" style={{ height: topSpacerHeight }} />
      )}
      {compact ? (
        <div className="compact-list">{cards}</div>
      ) : (
        <Masonry
          breakpointCols={numCols}
          className="masonry-grid"
          columnClassName="masonry-column"
        >
          {cards}
        </Masonry>
      )}
      {clampedLoaded < items.length && (
        <div ref={sentinelRef} className="scroll-sentinel" />
      )}
    </div>
  )
}
