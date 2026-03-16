import { useState, useEffect, useMemo } from 'react'
import initWasm, { readParquet } from 'parquet-wasm'
import { isLocalAuction } from '../utils/locality'

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

export function useAuctionData() {
  const [allItems, setAllItems] = useState([])
  const [auctions, setAuctions] = useState([])
  const [excludedAuctions, setExcludedAuctions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    // Fetch manifest to discover parquet files
    fetch(`${BASE}data/manifest.json`)
      .then(r => r.json())
      .then(safeIds =>
        Promise.all(safeIds.map(id =>
          fetchParquetAsObjects(`${BASE}data/items/${id}.parquet`)
        ))
      )
      .then(results => {
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
            items.push(row)

            const sid = row.auctionSafeId
            if (sid && !auctionMap[sid]) {
              auctionMap[sid] = {
                safeId: sid,
                id: row.auctionId,
                title: row.auctionTitle,
                endDate: row.auctionEndDate,
                scrapedAt: row.scrapedAt,
                isLocal: isLocalAuction(row.auctionTitle),
                totalItems: 0,
              }
            }
            if (sid) auctionMap[sid].totalItems++
          }
        }

        setAllItems(items)
        setAuctions(Object.values(auctionMap))
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

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
    error,
  }
}
