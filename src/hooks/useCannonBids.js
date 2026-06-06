// Cannon's/Maxanet "My Bids" integration.
//
// Calls the cannon-proxy Edge Function to:
//   - check whether the user has linked a Cannon's account (get_status)
//   - save or remove credentials (save_credentials / delete_credentials)
//   - fetch the set of Maxanet item IDs the user has bid on (get_bids)
//   - place a bid on a lot (place_bid)
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

  const refreshBids = useCallback(async () => {
    setBidsLoading(true)
    setError(null)
    const result = await callProxy('get_bids')
    setBidsLoading(false)
    if (result.error) { setError(result.error); return }
    setBidItemIds(new Set((result.itemIds ?? []).map(String)))
    const statusMap = new Map()
    for (const s of (result.statuses ?? [])) {
      statusMap.set(String(s.auctionItemId), {
        winning: s.winning,
        currentBid: s.currentBid,
        minimumNextBid: s.minimumNextBid,
      })
    }
    setBidStatuses(statusMap)
  }, [])

  // Fetch bids once we know the account is linked.
  useEffect(() => {
    if (!linked || !user) return
    ;(async () => { await refreshBids() })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, user?.id, refreshBids])

  const saveCredentials = useCallback(async (cannonUsername, cannonPassword) => {
    setError(null)
    const result = await callProxy('save_credentials', { username: cannonUsername, password: cannonPassword })
    if (result.error) return { error: result.error }
    setLinked(true)
    setUsername(cannonUsername)
    loadedUserId.current = user?.id ?? null
    refreshBids()
    return {}
  }, [user?.id, refreshBids])

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

    // Reflect the new state locally so the card badge + detail update without a
    // full refresh: the lot joins "My Bids" and its live status comes from the
    // function's post-bid RefreshItem read.
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
    return {
      ok: true,
      winning: result.winning,
      currentBid: result.currentBid,
      description: result.description,
    }
  }, [bidStatuses])

  const deleteCredentials = useCallback(async () => {
    setError(null)
    const result = await callProxy('delete_credentials')
    if (result.error) return { error: result.error }
    setLinked(false)
    setUsername(null)
    setBidItemIds(new Set())
    setBidStatuses(new Map())
    loadedUserId.current = null
    return {}
  }, [])

  return {
    linked,
    username,
    bidItemIds,
    bidStatuses,
    statusLoading,
    bidsLoading,
    error,
    saveCredentials,
    deleteCredentials,
    refreshBids,
    placeBid,
  }
}
