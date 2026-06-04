// Cannon's/Maxanet "My Bids" integration.
//
// Calls the cannon-proxy Edge Function to:
//   - check whether the user has linked a Cannon's account (get_status)
//   - save or remove credentials (save_credentials / delete_credentials)
//   - fetch the set of Maxanet item IDs the user has bid on (get_bids)
//
// Falls back gracefully when Supabase is not configured or the user is
// not signed in — returns unlinked state so the rest of the app is unaffected.

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

async function callProxy(action, params = {}) {
  if (!supabase) return { error: 'Not configured' }
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return { error: 'Not signed in' }
  const { data, error } = await supabase.functions.invoke('cannon-proxy', {
    body: { action, ...params },
  })
  if (error) return { error: error.message }
  return data ?? {}
}

export function useCannonBids(user) {
  const [linked, setLinked] = useState(false)
  const [username, setUsername] = useState(null)
  const [bidItemIds, setBidItemIds] = useState(() => new Set())
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

  const deleteCredentials = useCallback(async () => {
    setError(null)
    const result = await callProxy('delete_credentials')
    if (result.error) return { error: result.error }
    setLinked(false)
    setUsername(null)
    setBidItemIds(new Set())
    loadedUserId.current = null
    return {}
  }, [])

  return {
    linked,
    username,
    bidItemIds,
    statusLoading,
    bidsLoading,
    error,
    saveCredentials,
    deleteCredentials,
    refreshBids,
  }
}
