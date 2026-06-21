// @ts-nocheck
import { useState, useEffect, useMemo } from 'react'
import { itemTimeRemaining } from '../utils/time'
import { EbayComps } from './EbayComps'
import { CannonsComps } from './CannonsComps'
import { CategorySoldHistory } from './CategorySoldHistory'
import { RoiCalculator } from './RoiCalculator'
import { getDisplayEnrichment } from '../utils/enrichment'
import { buildEbaySoldSearchUrl } from '../utils/ebayComps'
import { buildFacebookMarketplaceSearchUrl } from '../utils/facebookMarketplace'
import { ResaleInsightsGate } from './ResaleInsightsGate'
import { BidPanel } from './BidPanel'
import { FbListingModal } from './FbListingModal'
import { useFullImages } from '../hooks/useFullImages'

const SPA_ORIGIN = 'https://gooners.anders.omg.lol'
const OG_WORKER_URL = import.meta.env.VITE_OG_WORKER_URL ?? null

function isHiBidUrl(value) {
  try {
    const { hostname } = new URL(value)
    return hostname === 'hibid.com' || hostname.endsWith('.hibid.com')
  } catch {
    return false
  }
}

export function ItemDetail({ item, ebayComps = {}, cannonsComps = {}, categoryStats, margin, locked = false, onSignInClick, cannonBids, bidStatus, user, onCannonLinkClick, isFavorite, onToggleFavorite, isIgnored, onToggleIgnored, onClose }) {
  const [imageState, setImageState] = useState({ itemKey: null, imgIndex: 0 })
  const [shareLabel, setShareLabel] = useState(null)
  const [showFbModal, setShowFbModal] = useState(false)
  const [showCarouselHint, setShowCarouselHint] = useState(false)
  // The grid carries only the thumbnail (the _card view trims images[] to the
  // first element); pull the full image set for the carousel and for any child
  // that needs every photo (e.g. FbListingModal's photo assessment). Memoized
  // so the hydrated item keeps a stable identity across re-renders — otherwise
  // FbListingModal would re-run its listing-generation effect on every render.
  const images = useFullImages(item)
  const itemWithImages = useMemo(
    () => (item ? { ...item, images } : item),
    [item, images]
  )

  const itemKey = item ? `${item.auctionSafeId || ''}:${item.id}` : null

  // Use the Cloudflare Worker (VITE_OG_WORKER_URL) for item-specific rich
  // previews when configured; fall back to the SPA URL (site-level OG tags)
  // otherwise. The Supabase edge function can't be used here because its gateway
  // overrides Content-Type: text/html → text/plain, breaking all crawlers.
  const shareUrl = itemKey
    ? OG_WORKER_URL
      ? `${OG_WORKER_URL}?item=${encodeURIComponent(itemKey)}`
      : `${SPA_ORIGIN}/?item=${encodeURIComponent(itemKey)}`
    : window.location.href

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({ title: item?.title, url: shareUrl }).catch(() => {})
    } else {
      navigator.clipboard.writeText(shareUrl).then(() => {
        setShareLabel('Copied!')
        setTimeout(() => setShareLabel(null), 2000)
      }).catch(() => {})
    }
  }

  // Reflect the open item in the browser tab title (helps history + share sheets).
  useEffect(() => {
    if (!item) return
    const prev = document.title
    document.title = `${item.title} | James River Gooners`
    return () => { document.title = prev }
  }, [item])

  // Show carousel hint briefly when a multi-image item opens
  useEffect(() => {
    if (!itemKey || images.length <= 1) return
    setShowCarouselHint(true)
    const t = setTimeout(() => setShowCarouselHint(false), 3000)
    return () => clearTimeout(t)
  }, [itemKey, images.length])

  // Close on Escape; navigate carousel with ArrowLeft / ArrowRight
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (images.length <= 1) return
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      setImageState(s => {
        const cur = s.itemKey === itemKey ? Math.min(s.imgIndex, images.length - 1) : 0
        const delta = e.key === 'ArrowLeft' ? -1 : 1
        return { itemKey, imgIndex: (cur + delta + images.length) % images.length }
      })
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose, images.length, itemKey])

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  if (!item) return null

  const maxImgIndex = Math.max(images.length - 1, 0)
  const imgIndex = imageState.itemKey === itemKey
    ? Math.min(imageState.imgIndex, maxImgIndex)
    : 0
  const remaining = itemTimeRemaining(item)

  const setCurrentImgIndex = (updater) => {
    setImageState(prevState => {
      const currentIndex = prevState.itemKey === itemKey
        ? Math.min(prevState.imgIndex, maxImgIndex)
        : 0
      const rawIndex = typeof updater === 'function' ? updater(currentIndex) : updater
      const nextIndex = Math.max(0, Math.min(rawIndex, maxImgIndex))
      return { itemKey, imgIndex: nextIndex }
    })
  }

  const prev = () => setCurrentImgIndex(i => (i - 1 + images.length) % images.length)
  const next = () => setCurrentImgIndex(i => (i + 1) % images.length)

  const enrichment = getDisplayEnrichment(item)
  const usedLabelAsTitle = enrichment != null && /^lot\s*-/i.test(item.title || '')
  const displayTitle = usedLabelAsTitle ? enrichment.label : item.title
  const facebookCompsUrl = buildFacebookMarketplaceSearchUrl(item.searchQuery, { sold: true })
  const isFacebook = item.source === 'facebook'
  const isHiBid = isHiBidUrl(item.detailUrl)

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <button className="detail-close" onClick={onClose} aria-label="Close">&times;</button>

        {images.length > 0 && (
          <div className="detail-carousel">
            <img src={images[imgIndex]} alt={item.title} />
            {images.length > 1 && (
              <>
                <button className="carousel-prev" onClick={prev}>&lsaquo;</button>
                <button className="carousel-next" onClick={next}>&rsaquo;</button>
                <div className="carousel-dots">
                  {images.map((_, i) => (
                    <span
                      key={i}
                      className={`carousel-dot${i === imgIndex ? ' active' : ''}`}
                      onClick={() => setCurrentImgIndex(i)}
                    />
                  ))}
                </div>
                {showCarouselHint && (
                  <div className="carousel-hint">← → to browse photos</div>
                )}
              </>
            )}
          </div>
        )}

        <div className="detail-body">
          <div className="detail-title-row">
            <h2 className="detail-title">{displayTitle}</h2>
            <button
              type="button"
              className={`ignore-button detail-ignore${isIgnored ? ' active' : ''}`}
              aria-label={isIgnored ? 'Stop ignoring' : 'Not interested'}
              title={isIgnored ? 'Stop ignoring' : 'Not interested'}
              onClick={() => onToggleIgnored(item)}
            >
              ✕
            </button>
            <button
              type="button"
              className={`favorite-button detail-favorite${isFavorite ? ' active' : ''}`}
              aria-label={isFavorite ? 'Remove favorite' : 'Add favorite'}
              onClick={() => onToggleFavorite(item)}
            >
              {isFavorite ? '★' : '☆'}
            </button>
          </div>
          <div className="detail-category">
            {usedLabelAsTitle && item.lotNumber ? `Lot ${item.lotNumber} · ` : ''}
            {item.rawCategory || item.category}
          </div>

          {enrichment && (
            <div className="detail-enrichment">
              <div className="detail-enrichment-row">
                {!usedLabelAsTitle && <span className="detail-product-label">{enrichment.label}</span>}
                {enrichment.condition && <span className="item-condition">{enrichment.condition}</span>}
                {enrichment.isMixedLot && <span className="enrichment-badge enrichment-badge-mixed">Mixed lot</span>}
                {(() => {
                  const qty = parseInt(enrichment.quantity, 10)
                  return Number.isFinite(qty) && qty > 1
                    ? <span className="enrichment-badge enrichment-badge-qty">Qty {qty}</span>
                    : null
                })()}
                {enrichment.productUrl && (
                  <a
                    href={enrichment.productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="detail-product-link"
                  >
                    View product
                  </a>
                )}
              </div>

              {enrichment.conditionFlags.length > 0 && (
                <div className="enrichment-flags">
                  {enrichment.conditionFlags.map(flag => (
                    <span key={flag} className="enrichment-flag" title="Resale-risk flag">⚠ {flag}</span>
                  ))}
                </div>
              )}

              {enrichment.keyAttributes.length > 0 && (
                <div className="enrichment-chips">
                  {enrichment.keyAttributes.map(attr => (
                    <span key={attr} className="enrichment-chip">{attr}</span>
                  ))}
                </div>
              )}

              {enrichment.secondaryItems.length > 0 && (
                <div className="enrichment-secondary">
                  <div className="enrichment-secondary-label">Also in this lot</div>
                  <ul className="enrichment-secondary-list">
                    {enrichment.secondaryItems.map((sec, i) => (
                      <li key={`${sec.label}:${i}`} className="enrichment-secondary-item">
                        <span className="enrichment-secondary-name">{sec.label}</span>
                        {sec.searchQuery && (
                          <a
                            href={buildEbaySoldSearchUrl(sec.searchQuery)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="enrichment-secondary-link"
                          >
                            Search eBay
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="detail-price-section">
            <div className="detail-price-label">
              {(item.closed || bidStatus?.itemClosed) ? 'Final bid' : 'Current bid'}
            </div>
            <div className="detail-bid-row">
              <span className="detail-bid">${(bidStatus?.currentBid ?? item.currentBid).toLocaleString()}</span>
              <span className="detail-bids">
                {item.totalBids} bid{item.totalBids !== 1 ? 's' : ''}
                {item.uniqueBidders > 0 && ` · ${item.uniqueBidders} bidder${item.uniqueBidders !== 1 ? 's' : ''}`}
              </span>
            </div>
            {bidStatus?.winning != null && (item.closed || bidStatus.itemClosed) && (
              <div className={`bid-status-badge${bidStatus.winning ? ' bid-status-winning' : ' bid-status-outbid'}`}>
                {bidStatus.winning ? '✓ Won this lot' : `✗ Lost · winning bid was $${bidStatus.currentBid != null ? bidStatus.currentBid.toLocaleString() : '?'}`}
              </div>
            )}
          </div>

          {remaining && <div className="detail-time">{remaining}</div>}

          {item.description && (
            <div className="detail-description">{item.description}</div>
          )}

          <div className="detail-actions">
            {item.detailUrl && (
              <a
                href={item.detailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="detail-link"
              >
                {isFacebook
                  ? 'Open Facebook listing'
                  : isHiBid
                    ? 'Open on HiBid'
                    : "Open on Cannon's"}
              </a>
            )}
            {facebookCompsUrl && (
              <a
                href={facebookCompsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="detail-link"
              >
                Search Facebook comps
              </a>
            )}
            <button className="detail-share" onClick={handleShare} aria-label="Share">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
              {shareLabel ?? 'Share'}
            </button>
            {user && (
              <button
                type="button"
                className="detail-fb-listing-btn"
                onClick={() => setShowFbModal(true)}
                aria-label="Create Facebook Marketplace listing"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                </svg>
                List on FB
              </button>
            )}
          </div>
          {showFbModal && (
            <FbListingModal item={itemWithImages} onClose={() => setShowFbModal(false)} />
          )}

          {cannonBids && (
            <BidPanel
              item={item}
              cannonBids={cannonBids}
              bidStatus={bidStatus}
              user={user}
              onSignInClick={onSignInClick}
              onCannonLinkClick={onCannonLinkClick}
            />
          )}

          {/* Comps lead — they're the primary signal; the calculator is secondary (#88).
              The whole resale cluster is members-only: logged out, the data is
              RLS-gated to empty, so show a single sign-in CTA in its place. */}
          {locked ? (
            <ResaleInsightsGate onSignInClick={onSignInClick} />
          ) : (
            <>
              <EbayComps item={item} soldComps={ebayComps[item.id]} />
              <CannonsComps comps={cannonsComps[item.id]} />
              <CategorySoldHistory category={item.category} stats={categoryStats} currentBid={item.currentBid} />
              <RoiCalculator soldComps={ebayComps[item.id]} margin={margin} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
