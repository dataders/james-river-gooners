import { useState, useEffect, useMemo, useRef } from 'react'
import initWasm, { readParquet } from 'parquet-wasm'
import { isLocalAuction } from '../utils/locality'
import { normalizeManifest } from '../utils/manifest'

const BASE = import.meta.env.BASE_URL

let wasmReady = null
function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm()
  return wasmReady
}

async function fetchParquetAsObjects(url) {
  await ensureWasm()
  const resp = await fetch(url)
  const buffer = new Uint8Array(await resp.arrayBuffer())
  const arrowTable = readParquet(buffer)
  const { tableFromIPC } = await import('apache-arrow')
  const table = tableFromIPC(arrowTable.intoIPCStream())
  return table.toArray().map(row => row.toJSON())
}

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

function normalizeRows(results, archived) {
  const items = []
  const auctionMap = {}

  for (const rows of results) {
    for (const row of rows) {
      if (typeof row.images === 'string') {
        try { row.images = JSON.parse(row.images) } catch { row.images = [] }
      }
      // Convert BigInt values from Arrow to regular numbers
      if (typeof row.lotNumber === 'bigint') row.lotNumber = Number(row.lotNumber)
      if (typeof row.totalBids === 'bigint') row.totalBids = Number(row.totalBids)
      if (typeof row.currentBid === 'bigint') row.currentBid = Number(row.currentBid)
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

async function fetchDataset(manifestPath, { archived = false } = {}) {
  const manifestResp = await fetch(dataUrl(manifestPath))
  if (!manifestResp.ok) {
    throw new Error(`Failed to load ${manifestPath}: ${manifestResp.status}`)
  }
  const manifest = await manifestResp.json()
  const entries = normalizeManifest(manifest, { archived })
  const results = await Promise.all(entries.map(entry =>
    fetchParquetAsObjects(dataUrl(entry.itemsPath))
  ))
  return normalizeRows(results, archived)
}

export function useAuctionData(includeArchived = false) {
  const [activeItems, setActiveItems] = useState([])
  const [activeAuctions, setActiveAuctions] = useState([])
  const [archiveItems, setArchiveItems] = useState([])
  const [archiveAuctions, setArchiveAuctions] = useState([])
  const [archiveLoaded, setArchiveLoaded] = useState(false)
  const archiveLoadingRef = useRef(false)
  const [excludedAuctions, setExcludedAuctions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [archiveError, setArchiveError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetchDataset('data/manifest.json')
      .then(({ items, auctions }) => {
        if (cancelled) return
        setActiveItems(items)
        setActiveAuctions(auctions)
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
      if (idx >= 0) return prev.filter(id => id !== safeId)
      return [...prev, safeId]
    })
  }

  return {
    auctions,
    excludedAuctions,
    toggleAuction,
    items,
    loading,
    archiveLoading: includeArchived && !archiveLoaded && !archiveError,
    error,
    archiveError,
  }
}
