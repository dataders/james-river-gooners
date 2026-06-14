// @ts-nocheck
import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useImageSearch } from '../hooks/useImageSearch'

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp,image/gif'

function hoursLeft(item) {
  if (!item.endDate) return null
  const ms = new Date(item.endDate) - Date.now()
  if (ms < 0) return null
  const h = Math.floor(ms / 3_600_000)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export function ImageSearchModal({ onClose, items = [], user, onSearchInGrid, onSignInClick }) {
  const { analyzeImage, loading, result, error, clear } = useImageSearch()
  const [imageFile, setImageFile] = useState(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [soldHistory, setSoldHistory] = useState(null)
  const fileInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Fetch historical sold lots when we have an identification
  useEffect(() => {
    if (!result || !user || !supabase) return
    const term = [result.brand, result.model].filter(Boolean).join(' ')
      || (result.keywords || [])[0]
      || ''
    if (!term || term.length < 3) return
    let cancelled = false
    supabase
      // Read the gated public_sold_lots view (members-only auth predicate), not
      // the raw sold_lots compat view — keeps sold prices behind the login gate.
      .from('public_sold_lots')
      .select('item_id, auction_safe_id, title, description, final_bid, image_url, sold_at, category')
      .or(`title.ilike.%${term}%,description.ilike.%${term}%`)
      .gt('final_bid', 0)
      .order('sold_at', { ascending: false })
      .limit(6)
      .then(({ data }) => {
        if (!cancelled) setSoldHistory(data || [])
      })
    return () => { cancelled = true }
  }, [result, user])

  // Score current auction items against identification
  const matchingItems = useMemo(() => {
    if (!result || !items.length) return []
    const words = [
      result.brand,
      result.model,
      ...(result.keywords || []),
      ...(result.searchTerms ? result.searchTerms.split(/\s+/) : []),
    ]
      .filter(Boolean)
      .flatMap(w => w.toLowerCase().split(/\s+/))
      .filter(w => w.length > 2)

    if (!words.length) return []

    return items
      .map(item => {
        const text = `${item.title || ''} ${item.description || ''} ${item.category || ''} ${item.rawCategory || ''}`.toLowerCase()
        const score = words.filter(w => text.includes(w)).length
        return { item, score }
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(({ item }) => item)
  }, [result, items])

  const pickFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return
    setImageFile(file)
    setImagePreviewUrl(URL.createObjectURL(file))
    clear()
    setSoldHistory(null)
  }, [clear])

  const handleFileInput = (e) => pickFile(e.target.files?.[0])
  const handleCameraInput = (e) => pickFile(e.target.files?.[0])

  const handleDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    pickFile(e.dataTransfer.files?.[0])
  }

  const handleAnalyze = () => {
    if (imageFile) analyzeImage(imageFile)
  }

  const handleApplyToGrid = () => {
    if (result?.searchTerms) onSearchInGrid(result.searchTerms)
  }

  const formatPrice = (n) =>
    n != null ? `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : ''

  const formatDate = (iso) => {
    if (!iso) return ''
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    } catch { return '' }
  }


  return (
    <div className="image-search-overlay" onClick={onClose}>
      <div className="image-search-panel" onClick={e => e.stopPropagation()}>
        <div className="image-search-header">
          <span className="image-search-title">📷 Find Similar Lots</span>
          <button type="button" className="detail-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {!user && (
          <div className="image-search-gate">
            <p>Sign in to use image search.</p>
            <button type="button" className="image-search-signin-btn" onClick={onSignInClick}>
              Sign in
            </button>
          </div>
        )}

        {user && (
          <>
            {/* Upload zone */}
            <div
              className={`image-upload-zone${dragOver ? ' image-upload-zone--active' : ''}${imagePreviewUrl ? ' image-upload-zone--has-image' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => !imagePreviewUrl && fileInputRef.current?.click()}
            >
              {imagePreviewUrl ? (
                <img
                  src={imagePreviewUrl}
                  alt="Upload preview"
                  className="image-preview-img"
                />
              ) : (
                <div className="image-upload-prompt">
                  <span className="image-upload-icon">📸</span>
                  <span className="image-upload-hint">Drop a photo or tap to upload</span>
                </div>
              )}
            </div>

            {/* Input controls */}
            <div className="image-search-controls">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_TYPES}
                style={{ display: 'none' }}
                onChange={handleFileInput}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept={ACCEPTED_TYPES}
                capture="environment"
                style={{ display: 'none' }}
                onChange={handleCameraInput}
              />
              <button
                type="button"
                className="image-search-pick-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                {imagePreviewUrl ? 'Change photo' : 'Choose photo'}
              </button>
              <button
                type="button"
                className="image-search-pick-btn"
                onClick={() => cameraInputRef.current?.click()}
              >
                Use camera
              </button>
              {imageFile && (
                <button
                  type="button"
                  className="image-search-analyze-btn"
                  onClick={handleAnalyze}
                  disabled={loading}
                >
                  {loading ? 'Analyzing…' : '✨ Identify'}
                </button>
              )}
            </div>

            {error && (
              <div className="image-search-error">{error}</div>
            )}

            {/* Identification result */}
            {result && (
              <>
                <div className="identification-card">
                  <div className="identification-what">What is this?</div>
                  {(result.brand || result.model) && (
                    <div className="identification-name">
                      {[result.brand, result.model].filter(Boolean).join(' ')}
                    </div>
                  )}
                  <div className="identification-meta">
                    {result.category && <span>{result.category}</span>}
                    {result.estimatedValue && <span>Est. {result.estimatedValue}</span>}
                  </div>
                  {result.description && (
                    <div className="identification-description">{result.description}</div>
                  )}
                  {result.keywords?.length > 0 && (
                    <div className="identification-keywords">
                      {result.keywords.map(k => (
                        <span key={k} className="identification-keyword">{k}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Action row */}
                <div className="image-search-action-row">
                  <button
                    type="button"
                    className="image-search-grid-btn"
                    onClick={handleApplyToGrid}
                    title={`Search: ${result.searchTerms}`}
                  >
                    🔍 Search in grid
                  </button>
                  {result.ebaySearchUrl && (
                    <a
                      href={result.ebaySearchUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="image-search-ext-link"
                    >
                      eBay sold ↗
                    </a>
                  )}
                  {result.fbMarketplaceUrl && (
                    <a
                      href={result.fbMarketplaceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="image-search-ext-link"
                    >
                      FB Marketplace ↗
                    </a>
                  )}
                </div>

                {/* Matching current lots */}
                {matchingItems.length > 0 && (
                  <section className="image-search-section">
                    <h3 className="image-search-section-title">
                      Matching current lots ({matchingItems.length})
                    </h3>
                    <div className="image-search-lot-list">
                      {matchingItems.map(item => (
                        <div key={`${item.auctionSafeId}:${item.id}`} className="image-lot-item">
                          {item.images?.[0] && (
                            <img
                              src={item.images[0]}
                              alt=""
                              className="image-lot-thumb"
                              loading="lazy"
                            />
                          )}
                          <div className="image-lot-body">
                            <div className="image-lot-title">{item.title || item.description?.slice(0, 60)}</div>
                            <div className="image-lot-meta">
                              {item.currentBid > 0 && <span>{formatPrice(item.currentBid)}</span>}
                              {hoursLeft(item) && <span>{hoursLeft(item)} left</span>}
                              {item.category && <span>{item.category}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Historical sold lots */}
                {(soldHistory === null || soldHistory.length > 0) && (
                  <section className="image-search-section">
                    <h3 className="image-search-section-title">
                      Sold at Cannon's
                      {soldHistory?.length > 0 && ` (${soldHistory.length})`}
                    </h3>
                    {soldHistory === null ? (
                      <div className="image-search-loading">Loading sold history…</div>
                    ) : (
                      <div className="image-search-lot-list">
                        {soldHistory.map(lot => (
                          <div key={`${lot.auction_safe_id}:${lot.item_id}`} className="image-lot-item">
                            {lot.image_url && (
                              <img
                                src={lot.image_url}
                                alt=""
                                className="image-lot-thumb"
                                loading="lazy"
                              />
                            )}
                            <div className="image-lot-body">
                              <div className="image-lot-title">{lot.title || lot.description?.slice(0, 60)}</div>
                              <div className="image-lot-meta">
                                {lot.final_bid && <span className="image-lot-sold-price">{formatPrice(lot.final_bid)} sold</span>}
                                {lot.sold_at && <span>{formatDate(lot.sold_at)}</span>}
                                {lot.category && <span>{lot.category}</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}