import { useState } from 'react'

const SOURCE_LABELS = {
  cannons: null, // no prefix — Cannon's is the default context
  emerald_ventures: 'Emerald',
  past_chapters: 'Past Chapters',
  peoples_auction: 'Peoples',
}

function shortTitle(title, source) {
  // Cannon's format: "03/18/26: Gallery Consignments | ..." -> "03/18 Gallery Consignments"
  const match = title.match(/^(\d{2}\/\d{2})\/\d{2}:\s*(.+?)(?:\s*[|-]\s*(?:Cannon|Online|Richmond|Henrico|Providence).*)?$/i)
  if (match) {
    return `${match[1]} ${match[2]}`
  }
  const prefix = SOURCE_LABELS[source]
  const truncated = title.slice(0, prefix ? 32 : 40)
  return prefix ? `${prefix}: ${truncated}` : truncated
}

export function AuctionFilter({ auctions, excludedAuctions, onToggle }) {
  const [expanded, setExpanded] = useState(false)

  const shown = auctions.filter(a => !excludedAuctions.includes(a.safeId))
  const hidden = auctions.filter(a => excludedAuctions.includes(a.safeId))

  return (
    <div className="auction-filter">
      <button
        className="auction-filter-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="auction-filter-label">Auctions</span>
        <span className="auction-filter-summary">
          {shown.length} of {auctions.length}
        </span>
        <span className="auction-filter-arrow">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="auction-filter-body">
          <div className="filter-chips">
            {shown.map(a => (
              <button
                key={a.safeId}
                className={`filter-chip shown${a.archived ? ' archived' : ''}`}
                onClick={() => onToggle(a.safeId)}
                title={a.title}
              >
                {shortTitle(a.title, a.source)}
                {a.archived && <span className="archive-mark">archived</span>}
                <span className="chip-count">{a.totalItems}</span>
              </button>
            ))}
          </div>
          {hidden.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className="filter-chips">
                {hidden.map(a => (
                  <button
                    key={a.safeId}
                    className={`filter-chip hidden${a.archived ? ' archived' : ''}`}
                    onClick={() => onToggle(a.safeId)}
                    title={a.title}
                  >
                    <span className="x-mark">✕</span>
                    {shortTitle(a.title, a.source)}
                    {a.archived && <span className="archive-mark">archived</span>}
                    <span className="chip-count">{a.totalItems}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
