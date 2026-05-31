import { useEffect, useRef } from 'react'

const STEPS = [
  {
    icon: '🔍',
    title: 'Search',
    body: 'Type keywords to find items. AI-powered image search loads in the background — once the "AI ✓" badge appears, searches match visual similarity too.',
  },
  {
    icon: '🏷️',
    title: 'Category filters',
    body: 'Show or hide whole item categories. Click a group header to expand it, then toggle individual categories. Use "show all" / "hide all" to reset.',
  },
  {
    icon: '🎚️',
    title: 'Range sliders',
    body: 'Narrow results by current bid price, number of bids, or hours remaining. Drag either handle to set a range.',
  },
  {
    icon: '⭐',
    title: 'Favorites',
    body: 'Click the star on any card or in the detail panel to save an item. Hit the "Favorites" button in the toolbar to see only your saved items.',
  },
  {
    icon: '📋',
    title: 'Item detail',
    body: 'Click any card to open a detail panel with full photos, current bid, eBay sold comps, and an ROI calculator to estimate your potential profit.',
  },
  {
    icon: '💰',
    title: 'Best deals & comps',
    body: '"Best deals" shows items where the current bid is below typical eBay resale. "Has comp" filters to items with actual price data from eBay.',
  },
  {
    icon: '📍',
    title: 'Richmond area only',
    body: 'Toggle this to limit results to local Richmond auctions only, hiding items from other regions.',
  },
  {
    icon: '🗄️',
    title: 'Archived auctions',
    body: 'Turn this on to browse past auction data. Great for researching what similar items have sold for.',
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
        <p className="tutorial-subtitle">A better way to browse Cannon's Auctions. Here's what you can do:</p>
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
