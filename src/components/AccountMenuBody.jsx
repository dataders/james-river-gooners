// @ts-nocheck
import { useState, useRef, useEffect, useCallback } from 'react'

// The logged-in account menu items, shared by the desktop dropdown
// (AccountButton) and the mobile NavDrawer. Owns the change-password flow.
// `onAfterAction` lets the container (popover / drawer) close itself after an
// action that should dismiss it (sign out, Cannon's link, password saved).
export function AccountMenuBody({ auth, cannonBids, onCannonLinkClick, onAfterAction }) {
  const [changing, setChanging] = useState(false)
  const [newPass, setNewPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [passError, setPassError] = useState('')
  const [passNotice, setPassNotice] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (changing) inputRef.current?.focus() }, [changing])

  const handleChangePassword = useCallback(async (e) => {
    e.preventDefault()
    setBusy(true)
    setPassError('')
    const result = await auth.changePassword(newPass)
    setBusy(false)
    if (result?.error) { setPassError(result.error); return }
    setPassNotice('Password updated.')
    setNewPass('')
    setTimeout(() => {
      setChanging(false)
      setPassNotice('')
      onAfterAction?.()
    }, 1500)
  }, [auth, newPass, onAfterAction])

  return (
    <>
      <div className="account-dropdown-email" title={auth.user.email}>
        {auth.user.email}
      </div>
      <hr className="account-dropdown-divider" />
      {cannonBids && (
        <button
          type="button"
          className={`account-dropdown-item${cannonBids.linked ? ' account-dropdown-item--cannon-linked' : ''}`}
          role="menuitem"
          onClick={() => { onAfterAction?.(); onCannonLinkClick?.() }}
        >
          {cannonBids.linked ? `Cannon's ✓ (${cannonBids.username})` : "Link Cannon's account"}
        </button>
      )}
      {changing ? (
        <form className="account-change-pass-form" onSubmit={handleChangePassword}>
          <input
            ref={inputRef}
            type="password"
            className="account-change-pass-input"
            placeholder="New password"
            autoComplete="new-password"
            minLength={6}
            required
            value={newPass}
            onChange={e => setNewPass(e.target.value)}
          />
          {passError && <p className="account-dropdown-error">{passError}</p>}
          {passNotice && <p className="account-dropdown-notice">{passNotice}</p>}
          <div className="account-change-pass-actions">
            <button type="submit" className="account-dropdown-item account-dropdown-item--primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="account-dropdown-item" onClick={() => setChanging(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <button type="button" className="account-dropdown-item" role="menuitem" onClick={() => setChanging(true)}>
            Change password
          </button>
          <button type="button" className="account-dropdown-item" role="menuitem" onClick={() => { onAfterAction?.(); auth.signOut() }}>
            Sign out
          </button>
        </>
      )}
    </>
  )
}
