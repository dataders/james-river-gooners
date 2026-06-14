// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import { itemEnded } from '../utils/time'

// In-app bidding for Cannon's lots. Only Cannon's (Maxanet) lots can be bid on
// through the cannon-proxy Edge Function, and only while the lot is still live.
// The panel adapts to the viewer: signed-out → sign-in CTA; signed-in but no
// linked Cannon's account → link CTA; linked → a "Place a bid" button that opens
// a modal with a bid amount + optional max (proxy) bid field.
export function BidPanel({ item, cannonBids, bidStatus, user, onSignInClick, onCannonLinkClick }) {
  const [showModal, setShowModal] = useState(false)
  const [result, setResult] = useState(null)

  if (item.source !== 'cannons') return null
  const ended = item.closed || item.archived || itemEnded(item)
  if (ended) return null

  const minNext = bidStatus?.minimumNextBid ?? item.currentBid + 1

  function handleSuccess(res) {
    setResult(res)
    setShowModal(false)
  }

  return (
    <div className="bid-panel">
      <h3 className="bid-panel-title">Place a bid</h3>

      {!user ? (
        <>
          <p className="bid-panel-hint">Sign in and link your Cannon&apos;s account to bid without leaving this page.</p>
          <button type="button" className="bid-cta" onClick={onSignInClick}>Sign in to bid</button>
        </>
      ) : !cannonBids.linked ? (
        <>
          <p className="bid-panel-hint">Link your Cannon&apos;s account to bid here. Your login is encrypted before storage.</p>
          <button type="button" className="bid-cta" onClick={onCannonLinkClick}>Link Cannon&apos;s account</button>
        </>
      ) : (
        <>
          <p className="bid-panel-min">Minimum next bid: ${minNext.toLocaleString()}</p>
          <button type="button" className="bid-cta" onClick={() => { setResult(null); setShowModal(true) }}>
            Place a bid
          </button>
          {result && (
            <p className={`bid-panel-result${result.winning ? ' winning' : ' outbid'}`}>
              {result.winning
                ? `✓ Bid placed — you're winning${result.currentBid != null ? ` at $${result.currentBid.toLocaleString()}` : ''}.`
                : `Bid placed, but you've been outbid${result.currentBid != null ? ` — current bid is $${result.currentBid.toLocaleString()}` : ''}.`}
            </p>
          )}
        </>
      )}

      {showModal && (
        <BidModal
          item={item}
          cannonBids={cannonBids}
          minNext={minNext}
          onSuccess={handleSuccess}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  )
}

function BidModal({ item, cannonBids, minNext, onSuccess, onClose }) {
  const [bidAmount, setBidAmount] = useState(String(minNext))
  const [maxBid, setMaxBid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const overlayRef = useRef(null)
  const bidInputRef = useRef(null)

  useEffect(() => {
    bidInputRef.current?.focus()
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    const bid = Number(bidAmount)
    if (!Number.isFinite(bid) || bid <= 0) { setError('Enter a bid amount'); return }
    if (bid < minNext) { setError(`Bid must be at least $${minNext.toLocaleString()}`); return }
    const max = maxBid === '' ? bid : Number(maxBid)
    if (!Number.isFinite(max) || max < bid) { setError('Max bid must be at least your bid amount'); return }
    setBusy(true)
    setError('')
    const res = await cannonBids.placeBid(item, bid, max)
    setBusy(false)
    if (res?.error) { setError(res.error); return }
    onSuccess(res)
  }

  return (
    <div
      className="auth-overlay"
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="Place a bid"
    >
      <div className="auth-panel bid-modal-panel">
        <div className="auth-header">
          <h2 className="auth-title">Place a bid</h2>
          <button className="auth-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p className="bid-modal-item-name">{item.title}</p>

        <form className="bid-modal-form" onSubmit={handleSubmit}>
          <label className="bid-field">
            <span>Bid amount</span>
            <div className="bid-input-row">
              <span className="bid-currency">$</span>
              <input
                ref={bidInputRef}
                type="number"
                inputMode="decimal"
                min={minNext}
                step="1"
                placeholder={String(minNext)}
                value={bidAmount}
                onChange={e => setBidAmount(e.target.value)}
                disabled={busy}
              />
            </div>
            <span className="bid-field-hint">Minimum: ${minNext.toLocaleString()}</span>
          </label>

          <label className="bid-field">
            <span>Max bid <span className="bid-field-optional">(optional)</span></span>
            <div className="bid-input-row">
              <span className="bid-currency">$</span>
              <input
                type="number"
                inputMode="decimal"
                min={bidAmount || minNext}
                step="1"
                placeholder="Same as bid"
                value={maxBid}
                onChange={e => setMaxBid(e.target.value)}
                disabled={busy}
              />
            </div>
            <span className="bid-field-hint">Cannon&apos;s will auto-bid up to this amount on your behalf.</span>
          </label>

          {error && <p className="bid-panel-error" role="alert">{error}</p>}

          <button type="submit" className="bid-cta bid-modal-submit" disabled={busy}>
            {busy ? 'Placing bid…' : 'Place bid'}
          </button>
        </form>
      </div>
    </div>
  )
}