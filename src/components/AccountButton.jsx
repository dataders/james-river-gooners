import { useState, useRef, useEffect, useCallback } from 'react'

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M12 12c2.761 0 5-2.239 5-5s-2.239-5-5-5-5 2.239-5 5 2.239 5 5 5zm0 2c-3.337 0-10 1.676-10 5v1a1 1 0 001 1h18a1 1 0 001-1v-1c0-3.324-6.663-5-10-5z"/>
    </svg>
  )
}

export function AccountButton({ auth, onSignInClick }) {
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const [newPass, setNewPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [passError, setPassError] = useState('')
  const [passNotice, setPassNotice] = useState('')
  const ref = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  useEffect(() => {
    if (changing) inputRef.current?.focus()
  }, [changing])

  const openDropdown = useCallback(() => {
    setChanging(false)
    setNewPass('')
    setPassError('')
    setPassNotice('')
    setOpen(v => !v)
  }, [])

  const handleChangePassword = useCallback(async (e) => {
    e.preventDefault()
    setBusy(true)
    setPassError('')
    const result = await auth.changePassword(newPass)
    setBusy(false)
    if (result?.error) {
      setPassError(result.error)
      return
    }
    setPassNotice('Password updated.')
    setNewPass('')
    setTimeout(() => {
      setChanging(false)
      setPassNotice('')
      setOpen(false)
    }, 1500)
  }, [auth, newPass])

  if (!auth.available) return null

  if (auth.user) {
    return (
      <div className="account-menu" ref={ref}>
        <button
          type="button"
          className="account-icon-btn"
          onClick={openDropdown}
          aria-label="Account menu"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <PersonIcon />
        </button>
        {open && (
          <div className="account-dropdown" role="menu">
            <div className="account-dropdown-email" title={auth.user.email}>
              {auth.user.email}
            </div>
            <hr className="account-dropdown-divider" />
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
                <button
                  type="button"
                  className="account-dropdown-item"
                  role="menuitem"
                  onClick={() => setChanging(true)}
                >
                  Change password
                </button>
                <button
                  type="button"
                  className="account-dropdown-item"
                  role="menuitem"
                  onClick={() => { setOpen(false); auth.signOut() }}
                >
                  Sign out
                </button>
              </>
            )}
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
