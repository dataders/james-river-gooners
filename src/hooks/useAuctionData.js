import { useState, useEffect, useMemo, useRef } from 'react'
import { isLocalAuction } from '../utils/locality'
import { itemKey } from '../utils/itemKey'
import { normalizeManifest } from '../utils/manifest'
import { isPastDeadline } from '../utils/dates'
import { syncUrlParam } from '../utils/urlState'
import { fetchJsonWithRetry, fetchTextWithRetry } from '../utils/net'

// How often to re-check active auctions for a passed deadline (ms). Auctions
// rarely turn over second-to-second, so a coarse tick keeps the page reactive
// without re-deriving the item list on every render.
const DEADLINE_TICK_MS = 60000

const BASE = import.meta.env.BASE_URL

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

async function fetchNdjson(url) {
  const text = await fetchTextWithRetry(url)
  const rows = []
  for (const line of text.trim().split('\n')) {
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (err) {
      // One malformed line shouldn't sink the whole auction — skip it.
      console.warn(`Skipping malformed NDJSON line in ${url}:`, err)
    }
  }
  return rows
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
  const manifest = await fetchJsonWithRetry(dataUrl(manifestPath))
  const entries = normalizeManifest(manifest, { archived })

  const results = await Promise.all(entries.map(entry => {
    const path = entry.ndjsonPath || entry.itemsPath.replace('.parquet', '.ndjson')
    return fetchNdjson(dataUrl(path))
  }))
  const { items, auctions } = normalizeRowsNdjson(results, archived)

  // Carry each auction's safeId with its embeddings path: the .embeddings binary
  // stores bare item ids (unique within one auction), so the loader must namespace
  // them by safeId to form globally-unique keys when merging auctions in-browser.
  const embeddingEntries = entries.flatMap(e =>
    e.embeddingsPath ? [{ path: e.embeddingsPath, safeId: e.safeId }] : []
  )
  return { items, auctions, embeddingEntries, loadTimeMs: Math.round(performance.now() - t0) }
}

export function useAuctionData(includeArchived = false) {
  const [activeItems, setActiveItems] = useState([])
  const [activeAuctions, setActiveAuctions] = useState([])
  const [activeEmbeddingEntries, setActiveEmbeddingEntries] = useState([])
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
  const [now, setNow] = useState(() => Date.now())

  // Re-evaluate deadlines on an interval so auctions that end while the page
  // stays open get archived without a reload.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), DEADLINE_TICK_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchDataset('data/manifest.json')
      .then(({ items, auctions, embeddingEntries, loadTimeMs }) => {
        if (cancelled) return
        setActiveItems(items)
        setActiveAuctions(auctions)
        setActiveEmbeddingEntries(embeddingEntries)
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

  // Active auctions whose deadline has already passed are treated as archived,
  // even though the backend hasn't moved them to the archive manifest yet.
  // Keyed on a stable string so the Set identity only changes when membership
  // changes (not on every minute tick), keeping downstream memos cheap.
  const dynamicArchivedKey = activeAuctions
    .filter(a => !a.archived && isPastDeadline(a.endDate, now))
    .map(a => a.safeId)
    .sort()
    .join(',')

  const dynamicArchivedIds = useMemo(
    () => new Set(dynamicArchivedKey ? dynamicArchivedKey.split(',') : []),
    [dynamicArchivedKey]
  )

  const allItems = useMemo(() => {
    if (includeArchived) {
      const active = dynamicArchivedIds.size === 0
        ? activeItems
        : activeItems.map(item => dynamicArchivedIds.has(item.auctionSafeId)
            ? { ...item, archived: true }
            : item)
      // The same lot can appear in both the active and archive snapshots while
      // an auction is mid-transition. De-dupe by the globally-unique composite
      // key (preferring the active copy) so downstream consumers never see a
      // collision. Keying on the bare id here would wrongly drop an archive lot
      // that merely shares an id with an unrelated active lot from another auction.
      const activeKeys = new Set(active.map(itemKey))
      const archiveOnly = archiveItems.filter(i => !activeKeys.has(itemKey(i)))
      return [...active, ...archiveOnly]
    }
    if (dynamicArchivedIds.size === 0) return activeItems
    return activeItems.filter(item => !dynamicArchivedIds.has(item.auctionSafeId))
  }, [activeItems, archiveItems, includeArchived, dynamicArchivedIds])

  const auctions = useMemo(() => {
    if (includeArchived) {
      const active = dynamicArchivedIds.size === 0
        ? activeAuctions
        : activeAuctions.map(a => dynamicArchivedIds.has(a.safeId)
            ? { ...a, archived: true }
            : a)
      return [...active, ...archiveAuctions]
    }
    if (dynamicArchivedIds.size === 0) return activeAuctions
    return activeAuctions.filter(a => !dynamicArchivedIds.has(a.safeId))
  }, [activeAuctions, archiveAuctions, includeArchived, dynamicArchivedIds])

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
    embeddingEntries: activeEmbeddingEntries,
    loading,
    loadTimeMs,
    archiveLoading: includeArchived && !archiveLoaded && !archiveError,
    error,
    archiveError,
  }
}
