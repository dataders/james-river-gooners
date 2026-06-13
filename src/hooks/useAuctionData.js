import { useState, useEffect, useMemo, useRef } from 'react'
import { itemKey } from '../utils/itemKey'
import { normalizeManifest } from '../utils/manifest'
import { isPastDeadline } from '../utils/dates'
import { syncUrlParam, readListParam, URL_PARAMS } from '../utils/urlState'
import { fetchJsonWithRetry, fetchTextWithRetry } from '../utils/net'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { captureEvent } from '../lib/telemetry'
import {
  normalizeRowsNdjson,
  normalizeRowsSupabase,
} from '../utils/auctionNormalize'

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

// --- Supabase dataset fetch ---

// PostgREST caps each response at the server's `max-rows` setting (1000 by
// default), so a page can never exceed this cap — a larger PAGE would come back
// short on the very first request and be mistaken for the end of the data.
const PAGE = 1000

async function fetchPage(viewName, from) {
  const { data, error } = await supabase.from(viewName).select('*').range(from, from + PAGE - 1)
  if (error) throw new Error(error.message)
  return data || []
}

// How many pages to fetch concurrently per wave. The old loop paged strictly
// sequentially — with ~6.6K active lots that's 7 serial round-trips against a
// slow free-tier instance, the bulk of the "Fetching auction data" wait.
// Fetching a wave of pages at once collapses that to a couple of round-trips,
// while the cap keeps it gentle: the E2E/usability suites open many pages at
// once (Playwright workers), and N workers × unbounded pages saturated
// free-tier Supabase's connections.
const PAGE_CONCURRENCY = 4

// Load every row from a paginated PostgREST view via adaptive parallel waves.
//
// We deliberately avoid a COUNT query: an exact COUNT over this view costs
// several seconds on the cold free-tier instance (as much as the data itself),
// and a planned/estimated count can be stale right after a scrape. Instead we
// fetch page 0 first (so `onFirstPage` can paint it as soon as possible —
// progressive render), then fetch the rest in PAGE_CONCURRENCY-wide waves,
// stopping as soon as a page comes back short (the last page). A trailing empty
// page per run is the only waste.
async function fetchAllFromView(viewName, onFirstPage) {
  const first = await fetchPage(viewName, 0)
  if (onFirstPage) onFirstPage(first)
  if (first.length < PAGE) return first

  const rows = [...first]
  let from = PAGE
  while (true) {
    const offsets = []
    for (let k = 0; k < PAGE_CONCURRENCY; k++) offsets.push(from + k * PAGE)
    const wave = await Promise.all(offsets.map(o => fetchPage(viewName, o)))
    let reachedEnd = false
    for (const page of wave) {
      rows.push(...page)
      if (page.length < PAGE) reachedEnd = true
    }
    if (reachedEnd) break
    from += PAGE_CONCURRENCY * PAGE
  }
  return rows
}

async function fetchSupabaseDataset({ archived = false, onPartial } = {}) {
  const t0 = performance.now()
  // The _card views slice images down to the first (thumbnail) element — the
  // only one the grid renders — cutting the payload roughly in half. The detail
  // panel hydrates the full image set on demand (see useFullImages).
  const viewName = archived ? 'public_archived_lots_card' : 'public_active_lots_card'
  const onFirstPage = onPartial
    ? rows => onPartial(normalizeRowsSupabase(rows, archived))
    : undefined
  const rows = await fetchAllFromView(viewName, onFirstPage)
  const { items, auctions } = normalizeRowsSupabase(rows, archived)
  return { items, auctions, loadTimeMs: Math.round(performance.now() - t0) }
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
  const { items, auctions } = normalizeRowsNdjson(results, entries, archived)
  return { items, auctions, loadTimeMs: Math.round(performance.now() - t0) }
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
  const [archiveItems, setArchiveItems] = useState([])
  const [archiveAuctions, setArchiveAuctions] = useState([])
  const [archiveLoaded, setArchiveLoaded] = useState(false)
  const archiveLoadingRef = useRef(false)
  const [excludedAuctions, setExcludedAuctions] = useState(() =>
    readListParam(URL_PARAMS.hideAuction)
  )
  const [loading, setLoading] = useState(true)
  // `loading` flips false as soon as the first page paints (progressive render);
  // `loadComplete` only flips once the entire active set is in, so consumers
  // that must see every item (e.g. the deep-link finder, the E2E suite) can
  // wait for the stable full count.
  const [loadComplete, setLoadComplete] = useState(false)
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
    // Paint the first page the moment it lands (Supabase path only — the NDJSON
    // path resolves its file fetches in one shot, so there's nothing partial to
    // show). The final `.then` below replaces this with the complete set. This
    // matters because the free-tier DB serves the full ~6.5K-row set slowly
    // (~10-20s); progressive render shows lots in ~2s regardless.
    const onPartial = isSupabaseConfigured
      ? ({ items, auctions }) => {
          if (cancelled) return
          setActiveItems(items)
          setActiveAuctions(auctions)
          setLoading(false)
        }
      : undefined
    const source = isSupabaseConfigured ? 'supabase' : 'ndjson'
    const activeLoader = isSupabaseConfigured
      ? () => fetchSupabaseDataset({ archived: false, onPartial })
      : () => fetchDataset('data/manifest.json')
    const startedAt = performance.now()
    activeLoader()
      .then(({ items, auctions, loadTimeMs }) => {
        if (cancelled) return
        setActiveItems(items)
        setActiveAuctions(auctions)
        setLoadTimeMs(loadTimeMs)
        setLoading(false)
        setLoadComplete(true)
        // Surface real-world load latency to telemetry so slowness is
        // measurable (and alertable) instead of just "feels slow". No-op when
        // analytics is unconfigured.
        captureEvent('dataset_loaded', {
          dataset: 'active',
          source,
          loadTimeMs,
          itemCount: items.length,
          auctionCount: auctions.length,
        })
      })
      .catch(e => {
        if (cancelled) return
        setError(e.message)
        setLoading(false)
        setLoadComplete(true)
        captureEvent('dataset_load_failed', {
          dataset: 'active',
          source,
          loadTimeMs: Math.round(performance.now() - startedAt),
          error: String(e && e.message ? e.message : e),
        })
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!includeArchived || archiveLoaded || archiveError || archiveLoadingRef.current) return
    let cancelled = false
    archiveLoadingRef.current = true
    const source = isSupabaseConfigured ? 'supabase' : 'ndjson'
    const archiveLoader = isSupabaseConfigured
      ? () => fetchSupabaseDataset({ archived: true })
      : () => fetchDataset('data/archive-manifest.json', { archived: true })
    const startedAt = performance.now()
    archiveLoader()
      .then(({ items, auctions, loadTimeMs }) => {
        if (cancelled) return
        setArchiveItems(items)
        setArchiveAuctions(auctions)
        setArchiveLoaded(true)
        archiveLoadingRef.current = false
        captureEvent('dataset_loaded', {
          dataset: 'archive',
          source,
          loadTimeMs,
          itemCount: items.length,
          auctionCount: auctions.length,
        })
      })
      .catch(e => {
        if (cancelled) return
        setArchiveError(e.message)
        archiveLoadingRef.current = false
        captureEvent('dataset_load_failed', {
          dataset: 'archive',
          source,
          loadTimeMs: Math.round(performance.now() - startedAt),
          error: String(e && e.message ? e.message : e),
        })
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
    let merged
    if (!includeArchived) {
      merged = dynamicArchivedIds.size === 0
        ? activeItems
        : activeItems.filter(item => !dynamicArchivedIds.has(item.auctionSafeId))
    } else {
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
      merged = archiveMode === 'archived'
        ? [...active, ...archiveOnly].filter(item => item.archived)
        : [...active, ...archiveOnly]
    }

    // De-dupe by composite key — a data-source bug (duplicate NDJSON row or
    // Supabase view returning the same lot twice) would otherwise crash the
    // MiniSearch index with "duplicate ID".
    const seen = new Set()
    return merged.filter(item => {
      const k = itemKey(item)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
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
      syncUrlParam(URL_PARAMS.hideAuction, next)
      return next
    })
  }

  const showAllAuctions = () => {
    setExcludedAuctions([])
    syncUrlParam(URL_PARAMS.hideAuction, [])
  }

  const showOnlyAuction = (safeId, allSafeIds) => {
    const excluded = allSafeIds.filter(id => id !== safeId)
    setExcludedAuctions(excluded)
    syncUrlParam(URL_PARAMS.hideAuction, excluded)
  }

  const hideSource = (source, allAuctions) => {
    setExcludedAuctions(prev => {
      const toAdd = allAuctions
        .filter(a => a.source === source && !prev.includes(a.safeId))
        .map(a => a.safeId)
      const next = [...prev, ...toAdd]
      syncUrlParam(URL_PARAMS.hideAuction, next)
      return next
    })
  }

  const showSource = (source, allAuctions) => {
    setExcludedAuctions(prev => {
      const sourceIds = new Set(
        allAuctions.filter(a => a.source === source).map(a => a.safeId)
      )
      const next = prev.filter(id => !sourceIds.has(id))
      syncUrlParam(URL_PARAMS.hideAuction, next)
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
    loading,
    loadComplete,
    loadTimeMs,
    archiveLoading: includeArchived && !archiveLoaded && !archiveError,
    error,
    archiveError,
  }
}
