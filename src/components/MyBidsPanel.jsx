// "My Bids" history panel — shows all bid rows from user_bids (active and
// archived auction items), sorted by status: open/winning first, then
// open/outbid, then closed. Reads directly from cannonBids.bidRows so no
// additional data fetch is needed.

import { useEffect } from 'react'

function timeAgo(isoString) {
  if (!isoString) return ''
  const diff = Date.now() - new Date(isoString).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function statusOrder(row) {
  if (row.item_closed) return 3
  if (row.is_winning === true) return 0
  if (row.is_winning === false) return 1
  return 2
}

export function MyBidsPanel({ cannonBids, onClose }) {
  const { bidRows, bidsLoading, refreshBids, markAlertsAsSeen, error } = cannonBids

  // Clear the notification badge as soon as the panel opens.
  useEffect(() => {
    markAlertsAsSeen?.()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = [...bidRows].sort((a, b) => {
    const so = statusOrder(a) - statusOrder(b)
    if (so !== 0) return so
    return new Date(b.last_bid_at) - new Date(a.last_bid_at)
  })

  const openCount = bidRows.filter(r => !r.item_closed).length
  const winningCount = bidRows.filter(r => !r.item_closed && r.is_winning === true).length
  const outbidCount = bidRows.filter(r => !r.item_closed && r.is_winning === false).length

  // Oldest status_refreshed_at among open items tells us when all statuses were last synced.
  const openRows = bidRows.filter(r => !r.item_closed && r.status_refreshed_at)
  const oldestRefresh = openRows.length > 0
    ? openRows.reduce((min, r) => r.status_refreshed_at < min ? r.status_refreshed_at : min, openRows[0].status_refreshed_at)
    : null

  return (
    <div
      className="tutorial-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="tutorial-panel my-bids-panel">
        <div className="my-bids-header">
          <div>
            <h2 className="my-bids-title">My Bids</h2>
            {bidRows.length > 0 && (
              <p className="my-bids-subtitle">
                {bidRows.length} total
                {openCount > 0 && ` · ${openCount} open`}
                {winningCount > 0 && ` · ${winningCount} winning`}
                {outbidCount > 0 && <span className="my-bids-outbid-count"> · {outbidCount} outbid</span>}
              </p>
            )}
            {oldestRefresh && (
              <p className="my-bids-refreshed-at">Checked {timeAgo(oldestRefresh)}</p>
            )}
          </div>
          <div className="my-bids-header-actions">
            <button
              type="button"
              className="my-bids-refresh"
              onClick={refreshBids}
              disabled={bidsLoading}
              title="Refresh bid statuses from Cannon's"
            >
              {bidsLoading ? '…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="tutorial-close"
              onClick={onClose}
              aria-label="Close My Bids"
            >
              ✕
            </button>
          </div>
        </div>

        {error && (
          <p className="my-bids-error">{error}</p>
        )}

        {bidsLoading && bidRows.length === 0 ? (
          <p className="my-bids-empty">Loading your bids…</p>
        ) : sorted.length === 0 ? (
          <p className="my-bids-empty">No bids yet.</p>
        ) : (
          <ul className="my-bids-list">
            {sorted.map(row => (
              <li key={row.auction_item_id} className={`my-bid-row${row.item_closed ? ' mb-closed' : ''}${!row.item_closed && row.is_winning === false ? ' mb-outbid' : ''}`}>
                <div className="mb-title">
                  {row.item_title || `Item ${row.auction_item_id}`}
                </div>
                <div className="mb-meta">
                  {row.item_closed ? (
                    <span className="mb-badge mb-badge-closed">Closed</span>
                  ) : row.is_winning === true ? (
                    <span className="mb-badge mb-badge-winning">Winning</span>
                  ) : row.is_winning === false ? (
                    <span className="mb-badge mb-badge-outbid">Outbid</span>
                  ) : (
                    <span className="mb-badge mb-badge-unknown">Pending</span>
                  )}
                  {row.current_bid != null && (
                    <span className="mb-bid-amount">
                      {row.item_closed ? 'Final' : 'Current'}: ${row.current_bid.toLocaleString()}
                    </span>
                  )}
                  {row.bid_amount != null && (
                    <span className="mb-your-bid">Your bid: ${row.bid_amount.toLocaleString()}</span>
                  )}
                  {!row.item_closed && row.status_refreshed_at ? (
                    <span className="mb-time" title={`Bid placed ${timeAgo(row.last_bid_at)}`}>checked {timeAgo(row.status_refreshed_at)}</span>
                  ) : (
                    <span className="mb-time">{timeAgo(row.last_bid_at)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
