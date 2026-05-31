import { useEffect, useRef } from 'react'

const STEPS = [
  {
    icon: '🔍',
    title: 'Search',
    body: 'Keyword search with fuzzy matching. "AI ✓" means image similarity search is also active.',
  },
  {
    icon: '🏷️',
    title: 'Categories & filters',
    body: 'Toggle categories on/off. Use the sliders to filter by price, bid count, or time remaining.',
  },
  {
    icon: '⭐',
    title: 'Favorites',
    body: 'Star any item to save it. Use the Favorites toggle to see only saved items.',
  },
  {
    icon: '📋',
    title: 'Item detail',
    body: 'Click a card for full photos, eBay sold comps, and an ROI calculator.',
  },
  {
    icon: '💰',
    title: 'Best deals',
    body: 'Highlights items where the current bid is below typical eBay resale price.',
  },
]

export function TutorialModal({ onClose }) {
  const overlayRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    closeRef.current?.focus()

    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleOverlayClick(e) {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div
      className="tutorial-overlay"
      ref={overlayRef}
      onClick={handleOverlayClick}
      role="dialog"
      aria-modal="true"
      aria-label="How to use this site"
    >
      <div className="tutorial-panel">
        <div className="tutorial-header">
          <h2 className="tutorial-title">Welcome to James River Gooners</h2>
          <button
            className="tutorial-close"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close tutorial"
          >
            ✕
          </button>
        </div>
        <p className="tutorial-subtitle">Here's what you can do:</p>
        <ul className="tutorial-steps">
          {STEPS.map(step => (
            <li key={step.title} className="tutorial-step">
              <span className="tutorial-step-icon" aria-hidden="true">{step.icon}</span>
              <div>
                <strong className="tutorial-step-title">{step.title}</strong>
                <p className="tutorial-step-body">{step.body}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="tutorial-footer">
          <button className="tutorial-got-it" onClick={onClose}>Got it!</button>
        </div>
      </div>
    </div>
  )
}
