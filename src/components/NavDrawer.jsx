// @ts-nocheck
import { useEffect } from 'react'
import { AccountMenuBody } from './AccountMenuBody.jsx'
import { ArsenalTrivia } from './ArsenalTrivia.jsx'

export function NavDrawer({
  open, onClose,
  onImageSearch, onSwipe, onTutorial, onWhatsNew, whatsNewUnseen,
  onFeedback,
  theme, onToggleTheme,
  auth, cannonBids, onSignInClick, onCannonLinkClick,
  baselineExcludedGroups, baselineExcludedCategories,
  onRemoveBaselineGroup, onRemoveBaselineCategory, onClearBaseline,
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  const act = (fn) => () => { onClose(); fn?.() }

  return (
    <div className="nav-drawer-overlay" data-testid="nav-drawer-overlay" onClick={onClose}>
      <div
        className="nav-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="nav-drawer-header">
          <span className="nav-drawer-title">Menu</span>
          <button type="button" className="nav-drawer-close" onClick={onClose} aria-label="Close menu">✕</button>
        </div>

        <div className="nav-drawer-body">
          <section className="nav-drawer-section">
            {auth.user ? (
              <AccountMenuBody
                auth={auth}
                cannonBids={cannonBids}
                onCannonLinkClick={act(onCannonLinkClick)}
                onAfterAction={onClose}
                baselineExcludedGroups={baselineExcludedGroups}
                baselineExcludedCategories={baselineExcludedCategories}
                onRemoveBaselineGroup={onRemoveBaselineGroup}
                onRemoveBaselineCategory={onRemoveBaselineCategory}
                onClearBaseline={onClearBaseline}
              />
            ) : (
              <button type="button" className="nav-drawer-item" onClick={act(onSignInClick)}>
                Sign in
              </button>
            )}
          </section>

          <hr className="nav-drawer-divider" />

          <section className="nav-drawer-section">
            <button type="button" className="nav-drawer-item" onClick={act(onImageSearch)}>
              <span className="nav-drawer-icon" aria-hidden="true">📷</span> Search by photo
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onSwipe)}>
              <span className="nav-drawer-icon" aria-hidden="true">⇄</span> Swipe to review
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onTutorial)}>
              <span className="nav-drawer-icon" aria-hidden="true">?</span> How to use this site
            </button>
            <button type="button" className="nav-drawer-item" onClick={act(onWhatsNew)}>
              <span className="nav-drawer-icon" aria-hidden="true">✨</span> What's new
              {whatsNewUnseen && <span className="nav-drawer-new-badge">New</span>}
            </button>
            <ArsenalTrivia
              className="nav-drawer-item"
              menuClassName="trivia-menu nav-drawer-trivia"
              triggerContent={<><span className="nav-drawer-icon" aria-hidden="true">⚽</span> Arsenal trivia</>}
            />
            <button type="button" className="nav-drawer-item" onClick={act(onFeedback)}>
              <span className="nav-drawer-icon" aria-hidden="true">✉</span> Send feedback
            </button>
          </section>

          <hr className="nav-drawer-divider" />

          <section className="nav-drawer-section">
            <button type="button" className="nav-drawer-item" onClick={onToggleTheme}>
              <span className="nav-drawer-icon" aria-hidden="true">{theme === 'dark' ? '☀' : '🌙'}</span>
              Theme: {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
