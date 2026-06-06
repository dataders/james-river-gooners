import { useState } from 'react'
import { itemTimeRemaining } from '../utils/time'

// In-app bidding for Cannon's lots. Only Cannon's (Maxanet) lots can be bid on
// through the cannon-proxy Edge Function, and only while the lot is still live.
// The panel adapts to the viewer: signed-out → sign-in CTA; signed-in but no
// linked Cannon's account → link CTA; linked → a max-bid form that posts the bid
// and reflects the resulting winning/outbid status inline.
export function BidPanel({ item, cannonBids, bidStatus, user, onSignInClick, onCannonLinkClick }) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  // Bidding is Cannon's-only and only meaningful while the lot is live.
  if (item.source !== 'cannons') return null
  const remaining = itemTimeRemaining(item)
  const ended = item.closed || item.archived || !remaining || remaining === 'Ended'
  if (ended) return null

  const minNext = bidStatus?.minimumNextBid ?? item.currentBid + 1

  async function handleSubmit(e) {
    e.preventDefault()
    if (busy) return
    const value = Number(amount)
    if (!Number.isFinite(value) || value <= 0) { setError('Enter a bid amount'); return }
    if (value < minNext) { setError(`Bid must be at least $${minNext.toLocaleString()}`); return }
    setBusy(true)
    setError('')
    setResult(null)
    const res = await cannonBids.placeBid(item, value)
    setBusy(false)
    if (res?.error) { setError(res.error); return }
    setResult(res)
    setAmount('')
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
          <form className="bid-form" onSubmit={handleSubmit}>
            <label className="bid-field">
              <span>Your max bid</span>
              <div className="bid-input-row">
                <span className="bid-currency">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={minNext}
                  step="1"
                  placeholder={String(minNext)}
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  disabled={busy}
                />
              </div>
            </label>
            <button type="submit" className="bid-cta bid-submit" disabled={busy}>
              {busy ? 'Placing bid…' : 'Place bid'}
            </button>
          </form>
          <p className="bid-panel-min">Minimum next bid: ${minNext.toLocaleString()}</p>
          {error && <p className="bid-panel-error" role="alert">{error}</p>}
          {result && (
            <p className={`bid-panel-result${result.winning ? ' winning' : ' outbid'}`}>
              {result.winning
                ? `✓ Bid placed — you're winning${result.currentBid != null ? ` at $${result.currentBid.toLocaleString()}` : ''}.`
                : `Bid placed, but you've been outbid${result.currentBid != null ? ` — current bid is $${result.currentBid.toLocaleString()}` : ''}.`}
            </p>
          )}
        </>
      )}
    </div>
  )
}
