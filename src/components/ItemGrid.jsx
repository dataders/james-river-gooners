// @ts-nocheck
import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { useWindowVirtualizer } from '@tanstack/react-virtual'
import { ItemCard } from './ItemCard'

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

// Initial per-item height guess for the virtualizer before real heights are
// measured. Auction cards run 300-450 px; compact rows are a short fixed list.
const ITEM_HEIGHT_ESTIMATE = 380
const COMPACT_ITEM_HEIGHT = 132

export function ItemGrid({ items, compact = false, allComps = {}, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onItemClick, bidStatuses, forYouScores = null }) {
  const wrapperRef = useRef(null)
  const [numCols, setNumCols] = useState(3)
  // The page (window) is the scroll container, so the virtual list must offset
  // by how far the grid sits below the top of the document.
  const [scrollMargin, setScrollMargin] = useState(0)

  // Track the grid's actual width so the column count never overruns the
  // available space (the sidebar makes window.innerWidth unreliable here), and
  // its document offset so the window-virtualizer positions rows correctly.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const update = () => {
      setNumCols(colsForWidth(wrapper.clientWidth))
      setScrollMargin(wrapper.offsetTop)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  const lanes = compact ? 1 : numCols
  const estimate = compact ? COMPACT_ITEM_HEIGHT : ITEM_HEIGHT_ESTIMATE

  // The active-filters bar above the grid appears/disappears as filters change,
  // shifting the grid's document offset; re-measure when the item set changes.
  useLayoutEffect(() => {
    if (wrapperRef.current) setScrollMargin(wrapperRef.current.offsetTop)
  }, [items])

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize: () => estimate,
    overscan: 6,
    lanes,
    gap: ITEM_GAP,
    scrollMargin,
    // Key by the globally-unique composite id so measured heights follow a lot
    // across filter/sort changes instead of being pinned to a list position.
    getItemKey: (index) => `${items[index].auctionSafeId}:${items[index].id}`,
  })

  // Re-pack when the column count flips (resize) or the layout mode changes.
  useEffect(() => {
    virtualizer.measure()
  }, [lanes, virtualizer])

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="item-grid-wrapper" ref={wrapperRef}>
      <div className="item-count">{items.length} items</div>
      <div
        className="virtual-grid"
        style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map(vi => {
          const item = items[vi.index]
          if (!item) return null
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="virtual-grid-cell"
              style={{
                position: 'absolute',
                top: 0,
                left: `${(vi.lane / lanes) * 100}%`,
                width: `${100 / lanes}%`,
                paddingInline: ITEM_GAP / 2,
                boxSizing: 'border-box',
                transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              <ItemCard
                item={item}
                compact={compact}
                itemComps={allComps[item.auctionSafeId]?.[item.id]}
                isFavorite={isFavorite(item)}
                onToggleFavorite={onToggleFavorite}
                isIgnored={isIgnored(item)}
                onToggleIgnored={onToggleIgnored}
                onItemClick={onItemClick}
                bidStatus={bidStatuses?.get(String(item.id))}
                forYouScore={forYouScores?.get(`${item.auctionSafeId}:${item.id}`)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}