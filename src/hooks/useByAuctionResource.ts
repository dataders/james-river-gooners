import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
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
 * useEnrichment. Each auction id becomes one TanStack Query (`[keyspace, id]`),
 * so the cache dedupes concurrent readers, survives unmounts, and retries on
 * its own — replacing the hand-rolled fetched-set / cancellation bookkeeping
 * (and its "fetched but stranded with no data" bug class) this hook used to own.
 *
 * `keyspace` namespaces the query keys so the three resources never collide in
 * the shared cache. `auctionSafeIds` may be a single id, an array, or
 * null/undefined (treated as none). `fetchOne` must be a *stable* reference
 * (module-level or useCallback) since it's the query function.
 *
 * Gating: returns the stable EMPTY map when Supabase is unconfigured or
 * `enabled` is false. Queries are merely *disabled* in that state, not removed,
 * so already-fetched data stays cached and re-exposes instantly when `enabled`
 * flips back on (the members-only comps gate, #149/#150, relies on this).
 *
 * Reference stability: the returned `{ [auctionSafeId]: T }` map keeps a stable
 * identity until the *set of loaded auctions* changes. Queries use
 * `staleTime: Infinity`, so a loaded auction's payload never changes identity
 * mid-session — which is what lets useItemPipeline's memos (and the grid's
 * scroll position) survive unrelated re-renders.
 */
export function useByAuctionResource<T>(
  keyspace: string,
  auctionSafeIds: string | string[] | null | undefined,
  fetchOne: (id: string) => Promise<AuctionResult<T>>,
  enabled = true,
): Record<string, T> {
  const active = enabled && isSupabaseConfigured

  const ids = useMemo(() => {
    if (Array.isArray(auctionSafeIds)) return auctionSafeIds.filter(Boolean)
    return auctionSafeIds ? [auctionSafeIds] : []
  }, [auctionSafeIds])

  const results = useQueries({
    queries: ids.map(id => ({
      queryKey: [keyspace, id],
      queryFn: () => fetchOne(id).then(r => r.items),
      enabled: active,
      staleTime: Infinity,
      gcTime: Infinity,
    })),
  })

  // Signature of *which* auctions have resolved data. With staleTime Infinity a
  // resolved payload's identity is fixed for the session, so this string changes
  // exactly when the map's contents would — letting the memo below hand back a
  // referentially-stable map on every other render.
  const loadedSig = ids
    .map((id, i) => (results[i]?.data !== undefined ? id : ''))
    .join('|')

  return useMemo(() => {
    if (!active) return EMPTY
    const map: Record<string, T> = {}
    ids.forEach((id, i) => {
      const data = results[i]?.data
      if (data !== undefined) map[id] = data as T
    })
    return (Object.keys(map).length ? map : EMPTY) as Record<string, T>
    // `results`/`ids` are intentionally omitted: loadedSig already captures every
    // transition that changes the map (an auction's data going undefined→loaded),
    // and including the fresh-every-render `results` array would defeat the
    // stable-identity guarantee this memo exists to provide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadedSig])
}
