import { useState } from 'react'
import { TRIVIA } from '../data/arsenalTrivia'

function getTodaysQuestion() {
  const daysSinceEpoch = Math.floor(Date.now() / 86_400_000)
  return TRIVIA[daysSinceEpoch % TRIVIA.length]
}

export function ArsenalTrivia() {
  const [revealed, setRevealed] = useState(false)
  const { question, answer } = getTodaysQuestion()

  return (
    <div className="trivia-card" onClick={() => setRevealed(r => !r)} role="button" aria-expanded={revealed}>
      <div className="trivia-label">⚽ Daily Arsenal Trivia</div>
      <div className="trivia-question">{question}</div>
      {revealed ? (
        <div className="trivia-answer">{answer}</div>
      ) : (
        <div className="trivia-tap-hint">Tap to reveal answer</div>
      )}
    </div>
  )
}
