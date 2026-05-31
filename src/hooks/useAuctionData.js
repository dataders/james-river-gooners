import { useState, useEffect, useMemo, useRef } from 'react'
import { isLocalAuction } from '../utils/locality'
import { normalizeManifest } from '../utils/manifest'
import { syncUrlParam } from '../utils/urlState'

const BASE = import.meta.env.BASE_URL

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

async function fetchNdjson(url) {
  const text = await fetch(url).then(r => r.text())
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function normalizeRowsNdjson(results, archived) {
  const items = []
  const auctionMap = {}
  for (const rows of results) {
    for (const row of rows) {
      row.archived = archived
      items.push(row)
      const sid = row.auctionSafeId
      if (sid && !auctionMap[sid]) {
        auctionMap[sid] = {
          safeId: sid,
          id: row.auctionId,
          title: row.auctionTitle,
          endDate: row.auctionEndDate,
          scrapedAt: row.scrapedAt,
          source: row.source || 'cannons',
          archived,
          isLocal: isLocalAuction(row.auctionTitle),
          totalItems: 0,
        }
      }
      if (sid) auctionMap[sid].totalItems++
    }
  }
  return { items, auctions: Object.values(auctionMap) }
}

// --- Shared dataset fetch ---

async function fetchDataset(manifestPath, { archived = false } = {}) {
  const t0 = performance.now()
  const manifestResp = await fetch(dataUrl(manifestPath))
  if (!manifestResp.ok) throw new Error(`Failed to load ${manifestPath}: ${manifestResp.status}`)
  const manifest = await manifestResp.json()
  const entries = normalizeManifest(manifest, { archived })

  const results = await Promise.all(entries.map(entry => {
    const path = entry.ndjsonPath || entry.itemsPath.replace('.parquet', '.ndjson')
    return fetchNdjson(dataUrl(path))
  }))
  const { items, auctions } = normalizeRowsNdjson(results, archived)

  const embeddingPaths = entries.flatMap(e => e.embeddingsPath ? [e.embeddingsPath] : [])
  return { items, auctions, embeddingPaths, loadTimeMs: Math.round(performance.now() - t0) }
}

export function useAuctionData(includeArchived = false) {
  const [activeItems, setActiveItems] = useState([])
  const [activeAuctions, setActiveAuctions] = useState([])
  const [activeEmbeddingPaths, setActiveEmbeddingPaths] = useState([])
  const [archiveItems, setArchiveItems] = useState([])
  const [archiveAuctions, setArchiveAuctions] = useState([])
  const [archiveLoaded, setArchiveLoaded] = useState(false)
  const archiveLoadingRef = useRef(false)
  const [excludedAuctions, setExcludedAuctions] = useState(() =>
    new URLSearchParams(window.location.search).getAll('hideAuction')
  )
  const [loading, setLoading] = useState(true)
  const [loadTimeMs, setLoadTimeMs] = useState(null)
  const [error, setError] = useState(null)
  const [archiveError, setArchiveError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchDataset('data/manifest.json')
      .then(({ items, auctions, embeddingPaths, loadTimeMs }) => {
        if (cancelled) return
        setActiveItems(items)
        setActiveAuctions(auctions)
        setActiveEmbeddingPaths(embeddingPaths)
        setLoadTimeMs(loadTimeMs)
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(e.message)
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!includeArchived || archiveLoaded || archiveError || archiveLoadingRef.current) return
    let cancelled = false
    archiveLoadingRef.current = true
    fetchDataset('data/archive-manifest.json', { archived: true })
      .then(({ items, auctions }) => {
        if (cancelled) return
        setArchiveItems(items)
        setArchiveAuctions(auctions)
        setArchiveLoaded(true)
        archiveLoadingRef.current = false
      })
      .catch(e => {
        if (cancelled) return
        setArchiveError(e.message)
        archiveLoadingRef.current = false
      })
    return () => {
      cancelled = true
      archiveLoadingRef.current = false
    }
  }, [includeArchived, archiveLoaded, archiveError])

  const allItems = useMemo(
    () => includeArchived ? [...activeItems, ...archiveItems] : activeItems,
    [activeItems, archiveItems, includeArchived]
  )

  const auctions = useMemo(
    () => includeArchived ? [...activeAuctions, ...archiveAuctions] : activeAuctions,
    [activeAuctions, archiveAuctions, includeArchived]
  )

  const items = useMemo(() => {
    if (excludedAuctions.length === 0) return allItems
    return allItems.filter(item => !excludedAuctions.includes(item.auctionSafeId))
  }, [allItems, excludedAuctions])

  const toggleAuction = (safeId) => {
    setExcludedAuctions(prev => {
      const idx = prev.indexOf(safeId)
      const next = idx >= 0 ? prev.filter(id => id !== safeId) : [...prev, safeId]
      syncUrlParam('hideAuction', next)
      return next
    })
  }

  return {
    auctions,
    excludedAuctions,
    toggleAuction,
    items,
    embeddingPaths: activeEmbeddingPaths,
    loading,
    loadTimeMs,
    archiveLoading: includeArchived && !archiveLoaded && !archiveError,
    error,
    archiveError,
  }
}
