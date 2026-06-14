// @ts-nocheck
import { useEffect, useRef, useState } from 'react'

// Modal for linking / unlinking a Cannon's Auctions account.
// Shows a credential form when unlinked; shows linked status + disconnect when linked.
// The password is sent over HTTPS to a Supabase Edge Function which encrypts it
// before storage — it is never stored in plaintext or accessible from the browser.

export function CannonLinkModal({ cannonBids, onClose }) {
  const { linked, username, bidsLoading, saveCredentials, deleteCredentials, refreshBids } = cannonBids

  const [cannonUsername, setCannonUsername] = useState('')
  const [cannonPassword, setCannonPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const overlayRef = useRef(null)
  const firstFieldRef = useRef(null)

  useEffect(() => {
    firstFieldRef.current?.focus()
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSave(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const result = await saveCredentials(cannonUsername.trim(), cannonPassword)
    setBusy(false)
    if (result?.error) { setError(result.error); return }
    setNotice('Linked! Fetching your bids…')
    setCannonPassword('')
  }

  async function handleDisconnect() {
    if (busy) return
    setBusy(true)
    setError('')
    const result = await deleteCredentials()
    setBusy(false)
    if (result?.error) setError(result.error)
    else onClose()
  }

  return (
    <div
      className="auth-overlay"
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="Link Cannon's Account"
    >
      <div className="auth-panel">
        <div className="auth-header">
          <h2 className="auth-title">Cannon&apos;s Account</h2>
          <button className="auth-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {linked ? (
          <div className="cannon-linked-body">
            <p className="cannon-linked-status">
              Linked as <strong>{username}</strong>
            </p>
            <p className="cannon-linked-hint">
              Your bid history is fetched each session so you can filter by &ldquo;My Bids&rdquo;.
            </p>
            <button
              type="button"
              className="auth-submit cannon-refresh-btn"
              onClick={refreshBids}
              disabled={bidsLoading}
            >
              {bidsLoading ? 'Refreshing…' : 'Refresh bids now'}
            </button>
            <button
              type="button"
              className="cannon-disconnect-btn"
              onClick={handleDisconnect}
              disabled={busy}
            >
              {busy ? 'Disconnecting…' : 'Disconnect Cannon\'s account'}
            </button>
            {error && <p className="auth-error" role="alert">{error}</p>}
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSave}>
            <p className="cannon-intro">
              Enter your <a href="https://bid.cannonsauctions.com" target="_blank" rel="noopener noreferrer">
                Cannon&apos;s Auctions
              </a> login to enable the &ldquo;My Bids&rdquo; filter. Your password is encrypted
              before storage and never shared.
            </p>

            <label className="auth-field">
              <span>Cannon&apos;s email / username</span>
              <input
                ref={firstFieldRef}
                type="text"
                autoComplete="username"
                required
                value={cannonUsername}
                onChange={e => setCannonUsername(e.target.value)}
              />
            </label>

            <label className="auth-field">
              <span>Cannon&apos;s password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={cannonPassword}
                onChange={e => setCannonPassword(e.target.value)}
              />
            </label>

            {error && <p className="auth-error" role="alert">{error}</p>}
            {notice && <p className="auth-notice">{notice}</p>}

            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? 'Linking…' : 'Link account'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}