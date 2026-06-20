import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ItemCard } from './ItemCard.jsx'

// Prevent network calls: useFullImages returns item.images directly in tests.
vi.mock('../hooks/useFullImages.js', () => ({
  useFullImages: (item: { images?: string[] } | null | undefined) => item?.images ?? [],
}))

const IMG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'

// Build a Touch-like object for fireEvent touch helpers.
// Cast via `unknown` to satisfy the Touch interface without a browser constructor.
const t = (clientX: number, clientY: number) =>
  ({ clientX, clientY }) as unknown as Touch

// querySelector that throws immediately if the element isn't found,
// giving a clear error instead of a confusing null-deref later.
function q(sel: string): Element {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`Element not found: ${sel}`)
  return el
}

// querySelectorAll + index with a clear throw (noUncheckedIndexedAccess makes
// NodeList[i] return Element | undefined, so we need an explicit guard).
function qAt(sel: string, i: number): Element {
  const el = [...document.querySelectorAll(sel)][i]
  if (!el) throw new Error(`Element not found: ${sel}[${i}]`)
  return el
}

function makeItem(over: Record<string, unknown> = {}) {
  return {
    id: 'test-1',
    auctionSafeId: 'test-auction',
    title: 'Test Item',
    category: 'Furniture',
    rawCategory: 'Furniture',
    currentBid: 100,
    totalBids: 3,
    uniqueBidders: 2,
    images: [IMG, IMG, IMG],
    ...over,
  }
}

function baseProps(over: Record<string, unknown> = {}) {
  return {
    item: makeItem(),
    compact: false,
    itemComps: null,
    isFavorite: false,
    isIgnored: false,
    onToggleFavorite: vi.fn(),
    onToggleIgnored: vi.fn(),
    onItemClick: vi.fn(),
    bidStatus: null,
    ...over,
  }
}

// Fire a complete swipe: touchstart → touchmove → touchend.
// The move is clearly horizontal (same y) so handleTouchMove activates.
function swipe(el: Element, { startX = 200, endX = 50, y = 100 } = {}) {
  fireEvent.touchStart(el, { touches: [t(startX, y)] })
  fireEvent.touchMove(el, { touches: [t(endX, y)] })
  fireEvent.touchEnd(el, { changedTouches: [t(endX, y)] })
}

describe('ItemCard carousel', () => {
  it('renders dots for a multi-image item', () => {
    render(<ItemCard {...baseProps()} />)
    // 3 images → 3 dot buttons (aria-label "Image N"); arrow buttons also present
    // but excluded by the ^Image anchor so "Next image" / "Previous image" don't match.
    expect(screen.getAllByRole('button', { name: /^Image \d+/i })).toHaveLength(3)
    // First dot is active on initial render
    expect(document.querySelector('.card-carousel-dot.active')).toBeTruthy()
  })

  it('does not render dots in compact mode', () => {
    render(<ItemCard {...baseProps({ compact: true })} />)
    expect(document.querySelector('.card-carousel-dots')).toBeNull()
  })

  it('does not render dots for a single-image item', () => {
    render(<ItemCard {...baseProps({ item: makeItem({ images: [IMG] }) })} />)
    expect(document.querySelector('.card-carousel-dots')).toBeNull()
  })

  it('left swipe advances to the next image', () => {
    render(<ItemCard {...baseProps()} />)
    swipe(q('.item-image'), { startX: 200, endX: 50 })

    expect(qAt('.card-carousel-dot', 0).classList.contains('active')).toBe(false)
    expect(qAt('.card-carousel-dot', 1).classList.contains('active')).toBe(true)
  })

  it('right swipe retreats to the previous image', () => {
    render(<ItemCard {...baseProps()} />)
    const el = q('.item-image')

    swipe(el, { startX: 200, endX: 50 }) // → index 1
    swipe(el, { startX: 50, endX: 200 }) // ← back to index 0

    expect(qAt('.card-carousel-dot', 0).classList.contains('active')).toBe(true)
  })

  it('clamps at the last image — does not wrap around', () => {
    render(<ItemCard {...baseProps({ item: makeItem({ images: [IMG, IMG] }) })} />)
    const el = q('.item-image')

    swipe(el, { startX: 200, endX: 50 }) // index 0 → 1
    swipe(el, { startX: 200, endX: 50 }) // attempt past the end → stays at 1

    expect(qAt('.card-carousel-dot', 1).classList.contains('active')).toBe(true)
  })

  it('clamps at the first image — does not wrap around', () => {
    render(<ItemCard {...baseProps({ item: makeItem({ images: [IMG, IMG] }) })} />)

    // Swipe right from index 0 — should stay at 0
    swipe(q('.item-image'), { startX: 50, endX: 200 })

    expect(qAt('.card-carousel-dot', 0).classList.contains('active')).toBe(true)
  })

  it('suppresses the click that fires after a touch swipe', () => {
    const onItemClick = vi.fn()
    render(<ItemCard {...baseProps({ onItemClick })} />)

    swipe(q('.item-image'), { startX: 200, endX: 50 })
    fireEvent.click(q('.item-card'))

    expect(onItemClick).not.toHaveBeenCalled()
  })

  it('allows a normal click (no preceding swipe) to open the item', () => {
    const onItemClick = vi.fn()
    render(<ItemCard {...baseProps({ onItemClick })} />)

    fireEvent.click(q('.item-card'))

    expect(onItemClick).toHaveBeenCalledOnce()
  })

  it('only renders <img> for the current slide and its immediate neighbours', () => {
    const fiveImages = [IMG, IMG, IMG, IMG, IMG]
    render(<ItemCard {...baseProps({ item: makeItem({ images: fiveImages }) })} />)

    const slides = document.querySelectorAll('.carousel-slide')
    const withImg = [...slides].filter(s => s.querySelector('img'))
    const withPlaceholder = [...slides].filter(s => s.querySelector('.carousel-slide-placeholder'))

    // At index 0: slide 0 (current) + slide 1 (next neighbour) get <img>; 2–4 get placeholders
    expect(withImg).toHaveLength(2)
    expect(withPlaceholder).toHaveLength(3)
  })

  it('after advancing, the new neighbours are rendered and far slides are placeholders', () => {
    const fiveImages = [IMG, IMG, IMG, IMG, IMG]
    render(<ItemCard {...baseProps({ item: makeItem({ images: fiveImages }) })} />)

    swipe(q('.item-image'), { startX: 200, endX: 50 }) // → index 1

    const slides = document.querySelectorAll('.carousel-slide')
    const withImg = [...slides].filter(s => s.querySelector('img'))
    const withPlaceholder = [...slides].filter(s => s.querySelector('.carousel-slide-placeholder'))

    // At index 1: slide 0 + slide 1 + slide 2 get <img>; 3 and 4 get placeholders
    expect(withImg).toHaveLength(3)
    expect(withPlaceholder).toHaveLength(2)
  })

  it('applies rubber-band damping when dragging past the first image', () => {
    render(<ItemCard {...baseProps()} />)
    const el = q('.item-image')
    const track = q('.carousel-track') as HTMLElement

    // Drag right 90px from index 0 (left boundary) — rubber-band gives 90/3 = 30px
    fireEvent.touchStart(el, { touches: [t(100, 100)] })
    fireEvent.touchMove(el, { touches: [t(190, 100)] })

    expect(track.style.transform).toMatch(/\+\s*30px/)
  })

  it('applies rubber-band damping when dragging past the last image', () => {
    render(<ItemCard {...baseProps({ item: makeItem({ images: [IMG, IMG] }) })} />)
    const el = q('.item-image')
    const track = q('.carousel-track') as HTMLElement

    swipe(el, { startX: 200, endX: 50 }) // advance to last image (index 1)

    // Drag left 90px from the last image — rubber-band gives -90/3 = -30px
    fireEvent.touchStart(el, { touches: [t(190, 100)] })
    fireEvent.touchMove(el, { touches: [t(100, 100)] })

    expect(track.style.transform).toMatch(/-30px/)
  })

  it('does not move the track for a predominantly vertical drag', () => {
    render(<ItemCard {...baseProps()} />)
    const el = q('.item-image')
    const track = q('.carousel-track') as HTMLElement

    // dy >> dx — should not activate horizontal drag
    fireEvent.touchStart(el, { touches: [t(100, 100)] })
    fireEvent.touchMove(el, { touches: [t(110, 200)] })

    const transform = track.style.transform || ''
    const match = transform.match(/\+\s*(-?[\d.]+)px/)
    const group = match?.[1]
    if (group !== undefined) {
      expect(parseFloat(group)).toBe(0)
    } else {
      expect(transform).not.toMatch(/\d+px/)
    }
  })

  it('dot click navigates to the correct image', () => {
    render(<ItemCard {...baseProps()} />)

    fireEvent.click(qAt('.card-carousel-dot', 2)) // jump directly to index 2

    expect(qAt('.card-carousel-dot', 2).classList.contains('active')).toBe(true)
    expect(qAt('.card-carousel-dot', 0).classList.contains('active')).toBe(false)
  })
})
