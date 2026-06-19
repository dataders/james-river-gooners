import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

interface Props {
  onClose: () => void
  user: { email: string } | null
}

const MAX_CHARS = 2000

export function FeedbackModal({ onClose, user }: Props) {
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState(user?.email ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [issueUrl, setIssueUrl] = useState('')
  const overlayRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  async function handleSubmit(e: { preventDefault: () => void }) {
    e.preventDefault()
    if (busy || !message.trim()) return
    setBusy(true)
    setError('')

    if (!isSupabaseConfigured || !supabase) {
      // Fallback: open the GitHub new-issue form so feedback is never lost.
      const params = new URLSearchParams({ title: 'User feedback', body: message.trim() })
      window.open(
        `https://github.com/dataders/james-river-gooners/issues/new?${params}`,
        '_blank',
        'noopener,noreferrer',
      )
      setBusy(false)
      setDone(true)
      return
    }

    const fnResult = await supabase.functions.invoke<{ issue_url: string }>(
      'create-feedback-issue',
      { body: { message: message.trim(), email: email.trim() || undefined } },
    )

    setBusy(false)
    const url = fnResult.data?.issue_url
    if (fnResult.error != null || url == null) {
      setError('Something went wrong — please try again.')
      return
    }
    setIssueUrl(url)
    setDone(true)
  }

  return (
    <div
      className="auth-overlay"
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="Send feedback"
    >
      <div className="auth-panel feedback-panel">
        <div className="auth-header">
          <h2 className="auth-title">Send feedback</h2>
          <button className="auth-close" onClick={onClose} aria-label="Close feedback">✕</button>
        </div>

        {done ? (
          <div className="feedback-done">
            <span className="feedback-done-icon" aria-hidden="true">✓</span>
            <p>Thanks — your feedback has been received.</p>
            {issueUrl && (
              <p className="feedback-issue-link">
                <a href={issueUrl} target="_blank" rel="noopener noreferrer">
                  View your issue on GitHub →
                </a>
              </p>
            )}
            <button type="button" className="auth-submit" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={e => { void handleSubmit(e) }}>
            <label className="auth-field">
              <span>What&apos;s on your mind?</span>
              <textarea
                ref={textareaRef}
                className="feedback-textarea"
                required
                maxLength={MAX_CHARS}
                value={message}
                onChange={e => { setMessage(e.target.value) }}
                placeholder="Bug report, feature idea, or anything else…"
                rows={5}
              />
              <span className="feedback-char-count">{message.length} / {MAX_CHARS}</span>
            </label>

            <label className="auth-field">
              <span>
                Email{' '}
                <span className="feedback-optional">(optional — only if you want a reply)</span>
              </span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => { setEmail(e.target.value) }}
              />
            </label>

            {error && <p className="auth-error" role="alert">{error}</p>}

            <button
              type="submit"
              className="auth-submit"
              disabled={busy || !message.trim()}
            >
              {busy ? 'Sending…' : 'Send feedback'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
