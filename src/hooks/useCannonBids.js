// Cannon's/Maxanet "My Bids" integration.
//
// Calls the cannon-proxy Edge Function to:
//   - check whether the user has linked a Cannon's account (get_status)
//   - save or remove credentials (save_credentials / delete_credentials)
//   - seed bid history from Maxanet watchlist on first login (get_bids)
//   - refresh live bid statuses from Maxanet (refresh_bid_statuses)
//   - place a bid on a lot (place_bid)
//
// On init, bids are read directly from the user_bids Supabase table (fast,
// no Maxanet round-trip). refreshBids() re-authenticates with Maxanet to
// update winning/currentBid status for open items, then re-reads the table.
//
// Falls back gracefully when Supabase is not configured or the user is
// not signed in — returns unlinked state so the rest of the app is unaffected.

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { callProxy as _callProxy } from '../utils/cannonProxy'

function callProxy(action, params = {}) {
  return _callProxy(action, params, supabase)
}

export function useCannonBids(user) {
  const [linked, setLinked] = useState(false)
  const [username, setUsername] = useState(null)
  const [bidItemIds, setBidItemIds] = useState(() => new Set())
  const [bidStatuses, setBidStatuses] = useState(() => new Map())
  const [bidRows, setBidRows] = useState([])
  const [statusLoading, setStatusLoading] = useState(false)
  const [bidsLoading, setBidsLoading] = useState(false)
  const [error, setError] = useState(null)

  const loadedUserId = useRef(null)

  // Load linked status when user signs in (once per user ID).
  // State mutations are inside the async IIFE to avoid the synchronous-setState-in-effect warning.
  useEffect(() => {
    if (!user || !isSupabaseConfigured) {
      loadedUserId.current = null
      return
    }
    if (loadedUserId.current === user.id) return
    loadedUserId.current = user.id

    let cancelled = false
    ;(async () => {
      setStatusLoading(true)
      const result = await callProxy('get_status')
      if (cancelled) return
      setStatusLoading(false)
      if (result.error) { setError(result.error); return }
      setLinked(result.linked ?? false)
      setUsername(result.username ?? null)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Read user_bids directly from Supabase (publishable key + RLS select policy).
  // Returns the rows array so callers can branch on empty for the backfill path.
  const loadBidsFromDb = useCallback(async () => {
    if (!user || !isSupabaseConfigured) return []
    const { data, error: dbErr } = await supabase
      .from('user_bids')
      .select('*')
      .order('last_bid_at', { ascending: false })
    if (dbErr) { setError(dbErr.message); return [] }
    const rows = data ?? []
    const ids = new Set(rows.map(r => String(r.auction_item_id)))
    const statusMap = new Map()
    for (const r of rows) {
      statusMap.set(String(r.auction_item_id), {
        winning: r.is_winning,
        currentBid: r.current_bid,
        minimumNextBid: r.min_next_bid,
        itemClosed: r.item_closed,
        statusRefreshedAt: r.status_refreshed_at,
      })
    }
    setBidItemIds(ids)
    setBidStatuses(statusMap)
    setBidRows(rows)
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // Load bids once the account is linked. If user_bids is empty (first login
  // for this user), seed it from the Maxanet watchlist via get_bids.
  useEffect(() => {
    if (!linked || !user) return
    let cancelled = false
    ;(async () => {
      setBidsLoading(true)
      const rows = await loadBidsFromDb()
      if (cancelled) return
      if (rows.length === 0) {
        await callProxy('get_bids')
        if (!cancelled) await loadBidsFromDb()
      }
      if (!cancelled) setBidsLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, user?.id, loadBidsFromDb])

  // Re-authenticate with Maxanet, refresh status for all open items, re-read DB.
  const refreshBids = useCallback(async () => {
    setBidsLoading(true)
    setError(null)
    const result = await callProxy('refresh_bid_statuses')
    if (result.error) { setBidsLoading(false); setError(result.error); return }
    await loadBidsFromDb()
    setBidsLoading(false)
  }, [loadBidsFromDb])

  const saveCredentials = useCallback(async (cannonUsername, cannonPassword) => {
    setError(null)
    const result = await callProxy('save_credentials', { username: cannonUsername, password: cannonPassword })
    if (result.error) return { error: result.error }
    setLinked(true)
    setUsername(cannonUsername)
    loadedUserId.current = user?.id ?? null
    // setLinked(true) triggers the "on linked" effect which handles the DB load + seed
    return {}
  }, [user?.id])

  // Place a bid (max/proxy) on a single lot. `amount` is the most the user is
  // willing to pay; it's sent as both the bid and the proxy ceiling. The real
  // minimum increment is enforced by Maxanet — we pass the best floor we know
  // (the live minimum from a prior bid, else current bid + $1) so the function's
  // own guard passes and Maxanet's own error (if any) flows back as the message.
  const placeBid = useCallback(async (item, bidAmount, maxBidAmount = bidAmount) => {
    setError(null)
    const known = bidStatuses.get(String(item.id))
    const minimumNextBid = known?.minimumNextBid ?? (item.currentBid + 1)
    const currentBid = known?.currentBid ?? item.currentBid
    const effectiveMax = (maxBidAmount != null && maxBidAmount >= bidAmount) ? maxBidAmount : bidAmount
    const result = await callProxy('place_bid', {
      auctionItemId: String(item.id),
      auctionId: String(item.auctionId),
      newBidAmount: bidAmount,
      maxBidAmount: effectiveMax,
      currentBid,
      minimumNextBid,
      itemName: item.title,
      endDate: item.endDate,
      totalBids: item.totalBids,
      category: item.rawCategory || item.category,
      skuNumber: item.lotNumber,
    })
    if (result.error) return { error: result.error }
    if (!result.ok) return { error: result.description || 'Bid failed' }

    // Optimistically update the card badge + detail without waiting for DB re-read.
    const id = String(item.id)
    setBidItemIds(prev => new Set(prev).add(id))
    setBidStatuses(prev => {
      const next = new Map(prev)
      next.set(id, {
        winning: result.winning,
        currentBid: result.currentBid,
        minimumNextBid: result.minimumNextBid,
      })
      return next
    })
    // Sync bidRows with the DB record the EF just wrote (non-blocking)
    loadBidsFromDb()
    return {
      ok: true,
      winning: result.winning,
      currentBid: result.currentBid,
      description: result.description,
    }
  }, [bidStatuses, loadBidsFromDb])

  const deleteCredentials = useCallback(async () => {
    setError(null)
    const result = await callProxy('delete_credentials')
    if (result.error) return { error: result.error }
    setLinked(false)
    setUsername(null)
    setBidItemIds(new Set())
    setBidStatuses(new Map())
    setBidRows([])
    loadedUserId.current = null
    return {}
  }, [])

  return {
    linked,
    username,
    bidItemIds,
    bidStatuses,
    bidRows,
    statusLoading,
    bidsLoading,
    error,
    saveCredentials,
    deleteCredentials,
    refreshBids,
    placeBid,
  }
}
