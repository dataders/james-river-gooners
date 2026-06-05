import { useState } from 'react'
import { normalizeCannonsComps, getCannonsCompMedian } from '../utils/cannonsComps'

// "Sold previously" — similar past auction lots and what they actually sold for,
// matched by CLIP similarity against the archive (scraper/cannons_comps.py).
export function CannonsComps({ comps }) {
  // Archived-lot photos can be purged from S3 over time; fall back to the
  // source-label placeholder for any thumbnail that fails to load.
  const [failed, setFailed] = useState(() => new Set())
  const matches = normalizeCannonsComps(comps)
  if (matches.length === 0) return null

  const median = getCannonsCompMedian(comps)
  const medianLabel = median
    ? `$${median.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : ''

  return (
    <section className="cannons-comps">
      <div className="cannons-comps-header">
        <h3>Sold previously</h3>
        {medianLabel && <span className="cannons-comps-median">median {medianLabel}</span>}
      </div>
      <div className="cannons-comp-list">
        {matches.slice(0, 5).map((comp, index) => {
          const card = (
            <>
              <div className="cannons-comp-thumb" aria-hidden="true">
                {comp.thumbnailUrl && !failed.has(index) ? (
                  <img
                    src={comp.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    onError={() => setFailed(prev => new Set(prev).add(index))}
                  />
                ) : (
                  <span>{comp.sourceLabel}</span>
                )}
              </div>
              <div className="cannons-comp-body">
                <div className="cannons-comp-topline">
                  <span className="cannons-comp-price">{comp.priceLabel}</span>
                  {comp.dateLabel && <span className="cannons-comp-date">{comp.dateLabel}</span>}
                </div>
                <div className="cannons-comp-title">{comp.title}</div>
                <div className="cannons-comp-meta">
                  {[comp.sourceLabel, comp.auctionTitle].filter(Boolean).join(' · ')}
                </div>
              </div>
            </>
          )
          return comp.detailUrl ? (
            <a
              key={`${comp.detailUrl}:${index}`}
              href={comp.detailUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cannons-comp-card"
            >
              {card}
            </a>
          ) : (
            <div key={index} className="cannons-comp-card">{card}</div>
          )
        })}
      </div>
    </section>
  )
}
