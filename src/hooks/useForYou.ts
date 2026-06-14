// Personalised "For You" sort: ranks active items by Nomic embedding similarity
// to the user's taste centroid (computed server-side from their favorites + bids).
//
// Only runs when enabled=true (i.e. sort==='foryou' AND the user has history).
// Re-fetches when the history item set or target auction set changes.

import { useState, useEffect } from 'react'
import type { Item, Auction } from '../types.ts'
import { supabase, isSupabaseConfigured } from '../lib/supabase.js'
import { compositeKey } from '../utils/itemKey.js'

export type ForYouStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ForYouResult {
  scoreByKey: Map<string, number>
  status: ForYouStatus
}

export function useForYou(
  favoriteItems: Item[],
  bidItems: Item[],
  auctions: Auction[],
  enabled: boolean,
): ForYouResult {
  const [scoreByKey, setScoreByKey] = useState<Map<string, number>>(() => new Map())
  const [status, setStatus] = useState<ForYouStatus>('idle')

  // Stable serialised keys so the effect only re-runs when the actual set changes.
  const historyKey = [...favoriteItems, ...bidItems]
    .map(i => compositeKey(i.auctionSafeId, i.id))
    .sort()
    .join(',')
  const targetKey = auctions.map(a => a.safeId).sort().join(',')

  useEffect(() => {
    if (!enabled || !isSupabaseConfigured || !supabase) {
      setStatus('idle')
      return
    }

    const historyItems = [...favoriteItems, ...bidItems]
    if (historyItems.length === 0) {
      setStatus('idle')
      return
    }

    const targetAuctionIds = auctions.map(a => a.safeId)
    const historyAuctionIds = historyItems.map(i => i.auctionSafeId)
    const historyItemIds = historyItems.map(i => String(i.id))

    let cancelled = false
    setStatus('loading')
    // Fire-and-forget: the cleanup `cancelled` flag (not awaiting) is how this
    // effect cancels a stale in-flight request, so mark the promise `void`.
    void (async () => {
      // supabase client is untyped (no generated Database type yet), so .rpc()
      // returns `any`; the row shape is asserted at the map below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { data, error } = await supabase.rpc('rank_for_you', {
        history_auction_ids: historyAuctionIds,
        history_item_ids: historyItemIds,
        target_auction_ids: targetAuctionIds,
      })
      if (cancelled) return
      if (error) {
        console.warn('[useForYou] RPC error:', error.message)
        setStatus('error')
        return
      }
      const map = new Map<string, number>()
      for (const row of (data ?? []) as { auction_safe_id: string; item_id: string; similarity: number }[]) {
        map.set(compositeKey(row.auction_safe_id, row.item_id), row.similarity)
      }
      setScoreByKey(map)
      setStatus('ready')
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, historyKey, targetKey])

  return { scoreByKey, status }
}
