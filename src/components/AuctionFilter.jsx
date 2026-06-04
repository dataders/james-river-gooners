import { useState } from 'react'

const SOURCE_LABELS = {
  cannons: "Cannon's",
  emerald_ventures: 'Emerald',
  past_chapters: 'Past Chapters',
  peoples_auction: 'Peoples',
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source
}

function shortAuctionTitle(title, source) {
  if (source === 'cannons') {
    // "06/04/26: Children's Museum of Richmond | Lake Harbor Dr..." → "06/04 Children's Museum of Richmond"
    const match = title.match(/^(\d{2}\/\d{2})\/\d{2}:\s*(.+?)(?:\s*[|]\s*(?:Cannon|Online|Richmond|Henrico|Providence|Petersburg|Dinwiddie|Chesterfield|Gordonsville|Sandston|Orange).*)?$/i)
    if (match) return `${match[1]} ${match[2].trim()}`
  }
  // HiBid: "June 6th, 2026 Sports Card & Comics Auction | Live and Online Auctions on HiBid.com" → "June 6 Sports Card & Comics"
  const hibid = title.match(/^(.+?)\s*\|\s*Live and Online/i)
  if (hibid) return hibid[1].replace(/(\d+)(?:st|nd|rd|th),?\s+\d{4}/, '$1').trim()
  return title.slice(0, 45)
}

function SourceGroup({ source, auctions, excludedAuctions, onToggle, onShowOnly, onHideSource, onShowSource }) {
  const [expanded, setExpanded] = useState(false)
  const shown = auctions.filter(a => !excludedAuctions.includes(a.safeId))
  const allHidden = shown.length === 0
  const someHidden = !allHidden && auctions.some(a => excludedAuctions.includes(a.safeId))
  const shownCount = shown.reduce((s, a) => s + (a.totalItems || 0), 0)
  const totalCount = auctions.reduce((s, a) => s + (a.totalItems || 0), 0)

  return (
    <div className={`auction-source-group${allHidden ? ' all-hidden' : ''}`}>
      <div className="filter-group-header">
        <button className="filter-group-toggle" onClick={() => setExpanded(!expanded)}>
          <span className="filter-group-arrow">{expanded ? '▾' : '▸'}</span>
          <span className="filter-group-name">{sourceLabel(source)}</span>
          <span className="filter-group-count">
            {allHidden ? `hidden (${totalCount})` : shownCount}
          </span>
        </button>
        {allHidden
          ? <button className="filter-action" onClick={() => onShowSource(source)}>show</button>
          : someHidden
            ? <button className="filter-action" onClick={() => onShowSource(source)}>show all</button>
            : <button className="filter-action" onClick={() => onHideSource(source)}>hide</button>
        }
      </div>

      {expanded && (
        <div className="filter-group-body">
          <div className="filter-chips">
            {shown.map(a => (
              <span key={a.safeId} className="filter-chip-wrap">
                <button
                  className={`filter-chip shown${a.archived ? ' archived' : ''}`}
                  onClick={() => onToggle(a.safeId)}
                  title={a.title}
                >
                  {shortAuctionTitle(a.title, source)}
                  {a.archived && <span className="archive-mark">archived</span>}
                  <span className="chip-count">{a.totalItems}</span>
                </button>
                {shown.length > 1 && (
                  <button
                    className="filter-chip-only"
                    title={`Show only ${shortAuctionTitle(a.title, source)}`}
                    aria-label={`Show only ${shortAuctionTitle(a.title, source)}`}
                    onClick={() => onShowOnly(a.safeId, auctions.map(x => x.safeId))}
                  >
                    only
                  </button>
                )}
              </span>
            ))}
            {auctions.filter(a => excludedAuctions.includes(a.safeId)).map(a => (
              <button
                key={a.safeId}
                className={`filter-chip hidden${a.archived ? ' archived' : ''}`}
                onClick={() => onToggle(a.safeId)}
                title={a.title}
              >
                <span className="x-mark">✕</span>
                {shortAuctionTitle(a.title, source)}
                {a.archived && <span className="archive-mark">archived</span>}
                <span className="chip-count">{a.totalItems}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AuctionFilter({ auctions, excludedAuctions, onToggle, onShowAll, onShowOnly, onHideSource, onShowSource }) {
  const [open, setOpen] = useState(false)

  // Group auctions by source, preserving encounter order
  const sourceOrder = []
  const bySource = {}
  for (const a of auctions) {
    if (!bySource[a.source]) {
      sourceOrder.push(a.source)
      bySource[a.source] = []
    }
    bySource[a.source].push(a)
  }

  const totalShown = auctions.filter(a => !excludedAuctions.includes(a.safeId)).length
  const someHidden = excludedAuctions.some(id => auctions.some(a => a.safeId === id))

  return (
    <div className="auction-filter">
      <div className="auction-filter-header">
        <button className="auction-filter-toggle" onClick={() => setOpen(!open)}>
          <span className="auction-filter-label">Auctions</span>
          <span className="auction-filter-summary">{totalShown} of {auctions.length}</span>
          <span className="auction-filter-arrow">{open ? '▾' : '▸'}</span>
        </button>
        {someHidden && (
          <button className="filter-action" onClick={onShowAll}>show all</button>
        )}
      </div>

      {open && (
        <div className="auction-filter-body">
          {sourceOrder.map(source => (
            <SourceGroup
              key={source}
              source={source}
              auctions={bySource[source]}
              excludedAuctions={excludedAuctions}
              onToggle={onToggle}
              onShowOnly={onShowOnly}
              onHideSource={onHideSource}
              onShowSource={onShowSource}
            />
          ))}
        </div>
      )}
    </div>
  )
}
