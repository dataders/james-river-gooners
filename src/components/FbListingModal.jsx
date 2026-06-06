import { useState, useEffect } from 'react'
import { generateFbListing } from '../utils/fbListing'
import { supabase } from '../lib/supabase'

function CopyButton({ text, className = 'fb-copy-btn' }) {
  const [label, setLabel] = useState('Copy')
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setLabel('Copied!')
      setTimeout(() => setLabel('Copy'), 2000)
    }).catch(() => {})
  }
  return (
    <button type="button" className={className} onClick={copy} aria-label="Copy to clipboard">
      {label}
    </button>
  )
}

function Field({ label, value, multiline = false }) {
  if (!value) return null
  return (
    <div className="fb-field">
      <div className="fb-field-header">
        <span className="fb-field-label">{label}</span>
        <CopyButton text={String(value)} />
      </div>
      {multiline
        ? <pre className="fb-field-value fb-field-multiline">{value}</pre>
        : <div className="fb-field-value">{value}</div>
      }
    </div>
  )
}

export function FbListingModal({ item, onClose }) {
  // attempt tracks retries; settled tracks the last completed attempt.
  // loading is derived: settled.attempt !== attempt (no setState in effect body).
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState({ attempt: -1, listing: null, error: null })

  useEffect(() => {
    let cancelled = false
    generateFbListing(item, supabase).then(result => {
      if (cancelled) return
      setSettled({
        attempt,
        listing: result.error ? null : result,
        error: result.error ?? null,
      })
    })
    return () => { cancelled = true }
  }, [item, attempt])

  const loading = settled.attempt !== attempt
  const { listing, error } = settled

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const buildCopyAll = () => {
    if (!listing) return ''
    const parts = [
      `Title: ${listing.title}`,
      `Price: $${listing.suggestedPrice}`,
      `Category: ${listing.fbCategory}`,
      `Condition: ${listing.fbCondition}`,
      '',
      listing.description,
    ]
    return parts.join('\n')
  }

  const usablePhotos = listing?.photoAssessment?.filter(p => p.usable) ?? []
  const unusablePhotos = listing?.photoAssessment?.filter(p => !p.usable) ?? []

  return (
    <div className="fb-overlay" onClick={onClose}>
      <div className="fb-modal" onClick={e => e.stopPropagation()}>
        <div className="fb-modal-header">
          <span className="fb-modal-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 6 }}>
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            Facebook Marketplace Listing
          </span>
          <button className="fb-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="fb-modal-body">
          {loading && (
            <div className="fb-loading">
              <div className="fb-spinner" />
              <p>Generating your listing…</p>
            </div>
          )}

          {!loading && error && (
            <div className="fb-error">
              <p>Could not generate listing: {error}</p>
              <button type="button" className="fb-retry-btn" onClick={() => setAttempt(a => a + 1)}>Try again</button>
            </div>
          )}

          {!loading && listing && (
            <>
              <div className="fb-fields">
                <Field label="Title" value={listing.title} />
                <div className="fb-field-row">
                  <Field label="Price" value={`$${listing.suggestedPrice}`} />
                  <Field label="Category" value={listing.fbCategory} />
                  <Field label="Condition" value={listing.fbCondition} />
                </div>
                <Field label="Description" value={listing.description} multiline />
              </div>

              {listing.photoAssessment?.length > 0 && (
                <div className="fb-photos-section">
                  <h3 className="fb-section-title">Photos</h3>
                  {usablePhotos.length > 0 && (
                    <div className="fb-photo-group">
                      <div className="fb-photo-group-label fb-photo-ok">Use these ({usablePhotos.length})</div>
                      <div className="fb-photo-grid">
                        {usablePhotos.map(p => (
                          <div key={p.index} className="fb-photo-card fb-photo-card-ok">
                            <img src={item.images?.[p.index]} alt={`Photo ${p.index + 1}`} className="fb-photo-thumb" />
                            <span className="fb-photo-note">{p.notes}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {unusablePhotos.length > 0 && (
                    <div className="fb-photo-group">
                      <div className="fb-photo-group-label fb-photo-skip">Skip these ({unusablePhotos.length})</div>
                      <div className="fb-photo-grid">
                        {unusablePhotos.map(p => (
                          <div key={p.index} className="fb-photo-card fb-photo-card-skip">
                            <img src={item.images?.[p.index]} alt={`Photo ${p.index + 1}`} className="fb-photo-thumb fb-photo-thumb-skip" />
                            <span className="fb-photo-note">{p.notes}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {listing.photoRecommendations?.length > 0 && (
                    <div className="fb-photo-recs">
                      <div className="fb-photo-group-label">Take these shots</div>
                      <ul className="fb-photo-rec-list">
                        {listing.photoRecommendations.map((rec, i) => (
                          <li key={i}>{rec}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <div className="fb-copy-all-row">
                <CopyButton text={buildCopyAll()} className="fb-copy-all-btn" />
                <span className="fb-copy-all-hint">Copies title, price, category, condition + description</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
