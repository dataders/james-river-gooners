import { useEffect, useRef, useState } from 'react'
import { isSupabaseConfigured } from '../lib/supabase'

// Stable empty result for the disabled / unconfigured path, so callers don't see
// a new object identity each render.
const EMPTY: Record<string, never> = {}

/** One auction's fetched payload, keyed back by its safe id. */
export interface AuctionResult<T> {
  id: string
  items: T
}

/**
 * Shared per-auction Supabase reader behind useEbayComps / useCannonsComps /
 * useEnrichment — three near-identical copies of this orchestration before the
 * extraction. Each auction id is fetched once via `fetchOne` and cached;
 * results merge into a `{ [auctionSafeId]: T }` map.
 *
 * `auctionSafeIds` may be a single id, an array, or null/undefined (treated as
 * none). `fetchOne` must be a *stable* reference (module-level or useCallback)
 * since it's an effect dependency.
 *
 * Gating: returns a stable empty map when Supabase is unconfigured or `enabled`
 * is false. Already-fetched data stays cached in state, so toggling `enabled`
 * back on re-exposes it instantly without a refetch (the members-only comps
 * gate, #149/#150, relies on this).
 *
 * Retry-safe: if the effect is torn down before its fetch resolves — React
 * StrictMode's dev double-invoke, or an ids/enabled change mid-flight — the
 * in-flight ids are un-marked so the next run refetches them. The original
 * useEbayComps/useCannonsComps copies omitted this and could permanently strand
 * an auction marked "fetched" but with no data (only useEnrichment had the fix).
 */
export function useByAuctionResource<T>(
  auctionSafeIds: string | string[] | null | undefined,
  fetchOne: (id: string) => Promise<AuctionResult<T>>,
  enabled = true,
): Record<string, T> {
  const [byAuction, setByAuction] = useState<Record<string, T>>({})
  const fetchedIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!isSupabaseConfigured || !enabled) return

    const ids = Array.isArray(auctionSafeIds)
      ? auctionSafeIds.filter(Boolean)
      : auctionSafeIds
        ? [auctionSafeIds]
        : []

    const fetched = fetchedIds.current
    const toFetch = ids.filter(id => !fetched.has(id))
    if (toFetch.length === 0) return

    for (const id of toFetch) fetched.add(id)

    let cancelled = false
    let completed = false

    Promise.all(toFetch.map(fetchOne)).then(results => {
      if (cancelled) return
      completed = true
      setByAuction(prev => {
        const next = { ...prev }
        for (const { id, items } of results) next[id] = items
        return next
      })
    })

    return () => {
      cancelled = true
      if (!completed) {
        for (const id of toFetch) fetched.delete(id)
      }
    }
  }, [auctionSafeIds, enabled, fetchOne])

  return enabled ? byAuction : (EMPTY as Record<string, T>)
}
