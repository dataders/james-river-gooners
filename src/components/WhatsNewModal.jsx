import { useEffect, useRef } from 'react'
import { CHANGELOG } from '../data/changelog'

const DATE_FMT = { month: 'short', day: 'numeric', year: 'numeric' }

function formatDate(iso) {
  // iso is YYYY-MM-DD; parse as local to avoid a UTC off-by-one day.
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, DATE_FMT)
}

export function WhatsNewModal({ onClose }) {
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
      aria-label="What's new"
    >
      <div className="tutorial-panel">
        <div className="tutorial-header">
          <h2 className="tutorial-title">What's new</h2>
          <button
            className="tutorial-close"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close what's new"
          >
            ✕
          </button>
        </div>
        <p className="tutorial-subtitle">Recent updates to James River Gooners.</p>
        <div className="changelog-body">
          {CHANGELOG.map(release => (
            <section key={release.date} className="changelog-release">
              <div className="changelog-release-head">
                <h3 className="changelog-release-title">{release.title}</h3>
                <time className="changelog-release-date" dateTime={release.date}>
                  {formatDate(release.date)}
                </time>
              </div>
              <ul className="changelog-changes">
                {release.changes.map((change, i) => (
                  <li key={i} className="changelog-change">
                    <span className="changelog-change-icon" aria-hidden="true">{change.icon}</span>
                    <span className="changelog-change-text">{change.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
