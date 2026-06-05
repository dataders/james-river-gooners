import { useState, useRef, useEffect, useCallback } from 'react'
import { itemTimeRemaining } from '../utils/time'

// Tinder-style review deck. One card at a time from a snapshot `items` list:
// swipe/drag right (or ♥ / →) to favorite, left (or ✕ / ←) to mark not
// interested, down (or ↓ / Skip) to pass without deciding. Decisions are
// reported up via onFavorite / onIgnore; the deck owns only its cursor + the
// in-flight drag so the parent's filtered list never reshuffles mid-review.

const SWIPE_THRESHOLD = 110 // px of horizontal travel that commits a decision
const FLY_DISTANCE = 1.5 // multiples of viewport width the card flies off-screen

export function SwipeDeck({ items, onFavorite, onIgnore, onClose }) {
  const [index, setIndex] = useState(0)
  // The card currently animating off-screen: { item, dir: 'left'|'right' }
  const [exiting, setExiting] = useState(null)
  const [drag, setDrag] = useState({ dx: 0, dy: 0, active: false })
  const startRef = useRef(null)
  const cardRef = useRef(null)

  const item = items[index]
  const remaining = item ? itemTimeRemaining(item) : null

  const commit = useCallback((dir) => {
    const current = items[index]
    if (!current) return
    if (dir === 'right') onFavorite(current)
    else if (dir === 'left') onIgnore(current)
    if (dir === 'down') {
      // Skip: no decision, just advance.
      setIndex(i => i + 1)
      setDrag({ dx: 0, dy: 0, active: false })
      return
    }
    setExiting({ item: current, dir })
    setDrag({ dx: 0, dy: 0, active: false })
    // Advance after the fly-off animation so the next card slides up cleanly.
    setTimeout(() => {
      setExiting(null)
      setIndex(i => i + 1)
    }, 280)
  }, [items, index, onFavorite, onIgnore])

  // Keyboard: ← ignore, → favorite, ↓ skip, Esc close.
  useEffect(() => {
    const onKey = (e) => {
      if (exiting) return
      if (e.key === 'Escape') { onClose(); return }
      if (!item) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); commit('left') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); commit('right') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); commit('down') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, onClose, item, exiting])

  // Lock body scroll while the deck is open.
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const onPointerDown = (e) => {
    if (exiting) return
    startRef.current = { x: e.clientX, y: e.clientY }
    setDrag({ dx: 0, dy: 0, active: true })
    cardRef.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e) => {
    if (!startRef.current) return
    setDrag({ dx: e.clientX - startRef.current.x, dy: e.clientY - startRef.current.y, active: true })
  }

  const onPointerUp = () => {
    if (!startRef.current) return
    startRef.current = null
    if (drag.dx > SWIPE_THRESHOLD) commit('right')
    else if (drag.dx < -SWIPE_THRESHOLD) commit('left')
    else setDrag({ dx: 0, dy: 0, active: false })
  }

  const total = items.length
  const done = !item && !exiting

  // Transform for the live (draggable) card.
  const liveRotate = drag.dx / 18
  const liveStyle = {
    transform: `translate(${drag.dx}px, ${drag.dy}px) rotate(${liveRotate}deg)`,
    transition: drag.active ? 'none' : 'transform 0.25s ease',
  }
  const likeOpacity = Math.max(0, Math.min(1, drag.dx / SWIPE_THRESHOLD))
  const nopeOpacity = Math.max(0, Math.min(1, -drag.dx / SWIPE_THRESHOLD))

  const renderCard = (cardItem, { style, live = false }) => {
    const img = cardItem.images?.[0] || null
    return (
      <div className="swipe-card" ref={live ? cardRef : undefined} style={style}
        onPointerDown={live ? onPointerDown : undefined}
        onPointerMove={live ? onPointerMove : undefined}
        onPointerUp={live ? onPointerUp : undefined}
        onPointerCancel={live ? onPointerUp : undefined}
      >
        {live && (
          <>
            <div className="swipe-badge swipe-badge-like" style={{ opacity: likeOpacity }}>★ KEEP</div>
            <div className="swipe-badge swipe-badge-nope" style={{ opacity: nopeOpacity }}>✕ NOPE</div>
          </>
        )}
        <div className="swipe-card-image">
          {img ? <img src={img} alt={cardItem.title} draggable="false" />
               : <div className="swipe-card-placeholder">{cardItem.title}</div>}
        </div>
        <div className="swipe-card-info">
          <div className="swipe-card-title">{cardItem.title}</div>
          <div className="swipe-card-meta">
            <span className="swipe-card-bid">${cardItem.currentBid.toLocaleString()}</span>
            <span className="swipe-card-category">{cardItem.rawCategory || cardItem.category}</span>
          </div>
          {remaining && live && <div className="swipe-card-time">{remaining}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="swipe-overlay" onClick={onClose}>
      <div className="swipe-stage" onClick={e => e.stopPropagation()}>
        <button className="swipe-close" onClick={onClose} aria-label="Close">&times;</button>
        <div className="swipe-progress">
          {done ? `${total} reviewed` : `${Math.min(index + 1, total)} / ${total}`}
        </div>

        <div className="swipe-deck">
          {done ? (
            <div className="swipe-empty">
              <p className="swipe-empty-title">All caught up</p>
              <p className="swipe-empty-hint">You&apos;ve reviewed every item in this view.</p>
              <button className="deals-toggle" onClick={onClose}>Done</button>
            </div>
          ) : (
            <>
              {/* Next card peeking underneath for depth */}
              {items[index + 1] && !exiting && renderCard(items[index + 1], {
                style: { transform: 'scale(0.95) translateY(12px)', zIndex: 0 },
              })}

              {exiting ? (
                renderCard(exiting.item, {
                  style: {
                    zIndex: 2,
                    transform: `translateX(${exiting.dir === 'right' ? '' : '-'}${FLY_DISTANCE * 100}vw) rotate(${exiting.dir === 'right' ? 25 : -25}deg)`,
                    transition: 'transform 0.28s ease-in',
                  },
                })
              ) : item ? (
                renderCard(item, { live: true, style: { zIndex: 1, ...liveStyle } })
              ) : null}
            </>
          )}
        </div>

        {!done && (
          <div className="swipe-actions">
            <button className="swipe-action swipe-action-nope" onClick={() => commit('left')} aria-label="Not interested" title="Not interested (←)">✕</button>
            <button className="swipe-action swipe-action-skip" onClick={() => commit('down')} aria-label="Skip" title="Skip (↓)">↓</button>
            <button className="swipe-action swipe-action-like" onClick={() => commit('right')} aria-label="Favorite" title="Favorite (→)">★</button>
          </div>
        )}
        <p className="swipe-hint">Drag or use ← ✕ &nbsp;·&nbsp; → ★ &nbsp;·&nbsp; ↓ skip</p>
      </div>
    </div>
  )
}
