import { useEffect, useRef, useState } from 'react'

// Email/password auth modal (issue #92). Three modes share one form: sign in,
// sign up, and request a password reset. Magic-link / OAuth are intentionally
// out of scope for now (backlog).

const COPY = {
  signin: { title: 'Sign in', submit: 'Sign in', toggle: "Need an account? Sign up" },
  signup: { title: 'Create account', submit: 'Sign up', toggle: 'Already have an account? Sign in' },
  reset: { title: 'Reset password', submit: 'Send reset link', toggle: 'Back to sign in' },
}

export function AuthModal({ auth, onClose }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const overlayRef = useRef(null)
  const emailRef = useRef(null)

  useEffect(() => {
    emailRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function switchMode(next) {
    setMode(next)
    setError('')
    setNotice('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')

    let result
    if (mode === 'signin') result = await auth.signIn(email, password)
    else if (mode === 'signup') result = await auth.signUp(email, password)
    else result = await auth.resetPassword(email)

    setBusy(false)

    if (result?.error) {
      setError(result.error)
      return
    }
    if (mode === 'signup' && result?.needsConfirmation) {
      setNotice('Check your email to confirm your account, then sign in.')
      setMode('signin')
      return
    }
    if (mode === 'reset') {
      setNotice('If that email has an account, a reset link is on its way.')
      return
    }
    // Successful sign in / auto-confirmed sign up — session is live.
    onClose()
  }

  const copy = COPY[mode]

  return (
    <div
      className="auth-overlay"
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
    >
      <div className="auth-panel">
        <div className="auth-header">
          <h2 className="auth-title">{copy.title}</h2>
          <button className="auth-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span>Email</span>
            <input
              ref={emailRef}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </label>

          {mode !== 'reset' && (
            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
                minLength={6}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </label>
          )}

          {error && <p className="auth-error" role="alert">{error}</p>}
          {notice && <p className="auth-notice">{notice}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? 'Working…' : copy.submit}
          </button>
        </form>

        <div className="auth-links">
          <button
            type="button"
            className="auth-link"
            onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
          >
            {copy.toggle}
          </button>
          {mode === 'signin' && (
            <button type="button" className="auth-link" onClick={() => switchMode('reset')}>
              Forgot password?
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
