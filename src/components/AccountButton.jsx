// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'
import { AccountMenuBody } from './AccountMenuBody.jsx'

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5zm0 2c-3.337 0-10 1.676-10 5v1a1 1 0 001 1h18a1 1 0 001-1v-1c0-3.324-6.663-5-10-5z"/>
    </svg>
  )
}

export function AccountButton({ auth, cannonBids, onSignInClick, onCannonLinkClick, onCategoryPrefsClick }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  const openDropdown = useCallback(() => setOpen(v => !v), [])

  if (!auth.available) return null

  if (auth.user) {
    const alertCount = cannonBids?.unseenAlertCount ?? 0
    return (
      <div className="account-menu" ref={ref}>
        <button
          type="button"
          className="account-icon-btn"
          onClick={openDropdown}
          aria-label={alertCount > 0 ? `Account menu (${alertCount} bid update${alertCount > 1 ? 's' : ''})` : 'Account menu'}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <PersonIcon />
          {alertCount > 0 && (
            <span className="bid-alert-badge" aria-hidden="true">
              {alertCount > 9 ? '9+' : alertCount}
            </span>
          )}
        </button>
        {open && (
          <div className="account-dropdown" role="menu">
            <AccountMenuBody
              auth={auth}
              cannonBids={cannonBids}
              onCannonLinkClick={onCannonLinkClick}
              onCategoryPrefsClick={onCategoryPrefsClick}
              onAfterAction={() => setOpen(false)}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      className="account-button"
      onClick={onSignInClick}
      disabled={auth.loading}
    >
      Sign in
    </button>
  )
}
