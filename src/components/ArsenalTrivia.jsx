// @ts-nocheck
import { useState, useRef, useEffect } from 'react'
import { TRIVIA } from '../data/arsenalTrivia'

function getTodaysQuestion() {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000)
  return TRIVIA[daysSinceEpoch % TRIVIA.length]
}

// Lives in the header banner as a compact ⚽ button (next to Swipe / help /
// account) that opens the daily question in a popover, rather than a full-width
// card eating space above the grid.
export function ArsenalTrivia() {
  const [open, setOpen] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const { question, answer } = getTodaysQuestion()
  const wrapRef = useRef(null)

  // Dismiss the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onPointer = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="trivia-menu" ref={wrapRef}>
      <button
        type="button"
        className="trivia-button"
        onClick={() => setOpen(o => !o)}
        title="Daily Arsenal trivia"
        aria-label="Daily Arsenal trivia"
        aria-expanded={open}
      >
        <span aria-hidden="true">⚽</span>
      </button>
      {open && (
        <div className="trivia-popover trivia-card">
          <div className="trivia-label">⚽ Daily Arsenal Trivia</div>
          <div
            className="trivia-body"
            onClick={() => setRevealed(r => !r)}
            role="button"
            aria-expanded={revealed}
          >
            <div className="trivia-question">{question}</div>
            {revealed ? (
              <div className="trivia-answer">{answer}</div>
            ) : (
              <div className="trivia-tap-hint">Tap to reveal answer</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}