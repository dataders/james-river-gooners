import { useEffect, useRef, useState } from 'react'

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  )
}

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

        {mode === 'signin' && (
          <>
            <button
              type="button"
              className="auth-google"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                const result = await auth.signInWithGoogle()
                if (result?.error) { setError(result.error); setBusy(false) }
                // On success the browser redirects; no need to close modal.
              }}
            >
              <GoogleIcon />
              Sign in with Google
            </button>
            <div className="auth-divider"><span>or</span></div>
          </>
        )}

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
