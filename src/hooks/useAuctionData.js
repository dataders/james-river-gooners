import { useState, useEffect, useMemo, useRef } from 'react'
import { isLocalAuction } from '../utils/locality'
import { itemKey } from '../utils/itemKey'
import { normalizeManifest } from '../utils/manifest'
import { isPastDeadline } from '../utils/dates'
import { syncUrlParam } from '../utils/urlState'
import { fetchJsonWithRetry, fetchTextWithRetry } from '../utils/net'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

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

// --- Supabase dataset fetch ---

async function fetchAllFromView(viewName) {
  // PostgREST caps each response at the server's `max-rows` setting (1000 by
  // default), so the page size must stay at or below that cap — a larger PAGE
  // would come back short on the very first request and the loop would quit
  // early, silently truncating the dataset to 1000 rows. Advance by the rows
  // actually returned so this self-adjusts if the cap ever changes.
  const PAGE = 1000
  const rows = []
  let from = 0
  while (true) {
    const { data, error } = await supabase.from(viewName).select('*').range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE) break
    from += data.length
  }
  return rows
}

function normalizeLotRow(row) {
  return {
    id: row.item_id,
    lotNumber: row.lot_number,
    title: row.title,
    description: row.description,
    currentBid: row.current_bid != null ? Number(row.current_bid) : 0,
    totalBids: row.total_bids ?? 0,
    uniqueBidders: row.unique_bidders ?? 0,
    endDate: row.end_date,
    images: row.images ?? [],
    category: row.category,
    rawCategory: row.raw_category,
    detailUrl: row.detail_url,
    auctionId: row.auction_id,
    auctionSafeId: row.auction_safe_id,
    auctionTitle: row.auction_title,
    auctionEndDate: row.auction_end_date,
    scrapedAt: row.scraped_at,
    source: row.source,
    ...(row.final_bid != null ? { finalBid: Number(row.final_bid) } : {}),
    ...(row.closed != null ? { closed: row.closed } : {}),
  }
}

function normalizeRowsSupabase(rows, archived) {
  const items = []
  const auctionMap = {}
  for (const row of rows) {
    const item = { ...normalizeLotRow(row), archived }
    items.push(item)
    const sid = item.auctionSafeId
    if (sid && !auctionMap[sid]) {
      auctionMap[sid] = {
        safeId: sid,
        id: item.auctionId,
        title: item.auctionTitle,
        endDate: item.auctionEndDate,
        scrapedAt: item.scrapedAt,
        source: item.source || 'cannons',
        archived,
        isLocal: isLocalAuction(item.auctionTitle),
        totalItems: 0,
      }
    }
    if (sid) auctionMap[sid].totalItems++
  }
  return { items, auctions: Object.values(auctionMap) }
}

async function fetchSupabaseDataset({ archived = false } = {}) {
  const t0 = performance.now()
  const viewName = archived ? 'public_archived_lots' : 'public_active_lots'
  const rows = await fetchAllFromView(viewName)
  const { items, auctions } = normalizeRowsSupabase(rows, archived)
  // Embeddings sidecars are not yet in Supabase (#132); semantic search
  // is unavailable when using the Supabase path.
  return { items, auctions, embeddingEntries: [], loadTimeMs: Math.round(performance.now() - t0) }
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

// archiveMode: 'active' (active auctions only), 'both' (active + archived),
// or 'archived' (archived only). Archived data is loaded whenever the mode
// isn't 'active'; 'archived' then filters the merged set down to archived
// entries so past-deadline auctions still surface even before the backend
// moves them into the archive manifest.
export function useAuctionData(archiveMode = 'active') {
  const includeArchived = archiveMode !== 'active'
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
    const activeLoader = isSupabaseConfigured
      ? () => fetchSupabaseDataset({ archived: false })
      : () => fetchDataset('data/manifest.json')
    activeLoader()
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
    const archiveLoader = isSupabaseConfigured
      ? () => fetchSupabaseDataset({ archived: true })
      : () => fetchDataset('data/archive-manifest.json', { archived: true })
    archiveLoader()
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
    if (!includeArchived) {
      if (dynamicArchivedIds.size === 0) return activeItems
      return activeItems.filter(item => !dynamicArchivedIds.has(item.auctionSafeId))
    }
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
    const merged = [...active, ...archiveOnly]
    if (archiveMode === 'archived') return merged.filter(item => item.archived)
    return merged
  }, [activeItems, archiveItems, includeArchived, archiveMode, dynamicArchivedIds])

  const auctions = useMemo(() => {
    if (!includeArchived) {
      if (dynamicArchivedIds.size === 0) return activeAuctions
      return activeAuctions.filter(a => !dynamicArchivedIds.has(a.safeId))
    }
    const active = dynamicArchivedIds.size === 0
      ? activeAuctions
      : activeAuctions.map(a => dynamicArchivedIds.has(a.safeId)
          ? { ...a, archived: true }
          : a)
    const merged = [...active, ...archiveAuctions]
    if (archiveMode === 'archived') return merged.filter(a => a.archived)
    return merged
  }, [activeAuctions, archiveAuctions, includeArchived, archiveMode, dynamicArchivedIds])

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

  const showAllAuctions = () => {
    setExcludedAuctions([])
    syncUrlParam('hideAuction', [])
  }

  const showOnlyAuction = (safeId, allSafeIds) => {
    const excluded = allSafeIds.filter(id => id !== safeId)
    setExcludedAuctions(excluded)
    syncUrlParam('hideAuction', excluded)
  }

  const hideSource = (source, allAuctions) => {
    setExcludedAuctions(prev => {
      const toAdd = allAuctions
        .filter(a => a.source === source && !prev.includes(a.safeId))
        .map(a => a.safeId)
      const next = [...prev, ...toAdd]
      syncUrlParam('hideAuction', next)
      return next
    })
  }

  const showSource = (source, allAuctions) => {
    setExcludedAuctions(prev => {
      const sourceIds = new Set(
        allAuctions.filter(a => a.source === source).map(a => a.safeId)
      )
      const next = prev.filter(id => !sourceIds.has(id))
      syncUrlParam('hideAuction', next)
      return next
    })
  }

  return {
    auctions,
    excludedAuctions,
    toggleAuction,
    showAllAuctions,
    showOnlyAuction,
    hideSource,
    showSource,
    items,
    embeddingEntries: activeEmbeddingEntries,
    loading,
    loadTimeMs,
    archiveLoading: includeArchived && !archiveLoaded && !archiveError,
    error,
    archiveError,
  }
}
