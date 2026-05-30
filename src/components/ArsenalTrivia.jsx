import { useState } from 'react'
import { TRIVIA } from '../data/arsenalTrivia'

function getTodaysQuestion() {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000)
  return TRIVIA[daysSinceEpoch % TRIVIA.length]
}

export function ArsenalTrivia() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('trivia-open') !== 'false' } catch { return true }
  })
  const [revealed, setRevealed] = useState(false)
  const { question, answer } = getTodaysQuestion()

  const toggleOpen = () => {
    setOpen(o => {
      const next = !o
      try { localStorage.setItem('trivia-open', String(next)) } catch { /* storage unavailable */ }
      return next
    })
  }

  return (
    <div className="trivia-card">
      <div className="trivia-header" onClick={toggleOpen}>
        <span className="trivia-label">⚽ Daily Arsenal Trivia</span>
        <span className={`trivia-chevron${open ? '' : ' trivia-chevron-closed'}`}>▾</span>
      </div>
      {open && (
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
      )}
    </div>
  )
}
