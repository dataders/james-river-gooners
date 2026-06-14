// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  favoriteKey,
  mergeFavoriteKeys,
  parseFavoritesCookie,
  serializeFavoritesCookie,
  toggleFavoriteKey,
} from '../utils/favorites'
import { supabase } from '../lib/supabase'
import { captureEvent } from '../lib/telemetry'

function loadFavoriteIds() {
  if (typeof document === 'undefined') return []
  return parseFavoritesCookie(document.cookie)
}

function saveFavoriteIds(ids) {
  if (typeof document === 'undefined') return
  document.cookie = serializeFavoritesCookie(ids)
}

// Cloud favorites, offline-first (issue #93).
//
// Logged out (or Supabase not configured): behaves exactly as before — the
// `gooners-favorites` cookie is the source of truth.
//
// Logged in: the Supabase `favorites` table is authoritative. On first login we
// merge the anonymous cookie favorites into the cloud set (union) and push any
// cookie-only keys up. Toggles are optimistic — local state updates immediately,
// the network write follows. The cookie is kept as a mirror so favorites still
// render instantly on reload and survive going offline.
export function useFavorites(user) {
  const [favoriteIds, setFavoriteIds] = useState(loadFavoriteIds)
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  // Track which user id we've already merged so a token refresh (which re-fires
  // the same user) doesn't re-run the merge.
  const mergedUserId = useRef(null)
  const userId = user?.id ?? null

  useEffect(() => {
    if (!supabase || !userId) {
      // Signed out: forget the merge marker so the next login merges again.
      mergedUserId.current = null
      return
    }
    if (mergedUserId.current === userId) return
    mergedUserId.current = userId

    let cancelled = false
    ;(async () => {
      const localIds = loadFavoriteIds()
      const { data, error } = await supabase
        .from('favorites')
        .select('item_key')
        .eq('user_id', userId)
      if (cancelled || error) {
        if (error) console.warn('Failed to load cloud favorites:', error.message)
        return
      }

      const cloudIds = data.map(row => row.item_key)
      const merged = mergeFavoriteKeys(cloudIds, localIds)

      const toInsert = localIds.filter(id => !cloudIds.includes(id))
      if (toInsert.length) {
        const { error: insertError } = await supabase
          .from('favorites')
          .upsert(
            toInsert.map(item_key => ({ user_id: userId, item_key })),
            { onConflict: 'user_id,item_key', ignoreDuplicates: true },
          )
        if (insertError) console.warn('Failed to sync local favorites up:', insertError.message)
      }

      if (cancelled) return
      setFavoriteIds(merged)
      saveFavoriteIds(merged)
    })()

    return () => { cancelled = true }
  }, [userId])

  const isFavorite = useCallback(
    item => favoriteSet.has(favoriteKey(item)),
    [favoriteSet],
  )

  // Add/remove `key` and fire the matching cloud write. No-op if already in the
  // desired state. Returns nothing; updates state + cookie optimistically.
  const writeKey = useCallback((key, shouldFavorite) => {
    setFavoriteIds(prev => {
      const has = prev.includes(key)
      if (has === shouldFavorite) return prev
      const next = toggleFavoriteKey(prev, key)
      saveFavoriteIds(next)

      if (supabase && userId) {
        const op = shouldFavorite
          ? supabase
              .from('favorites')
              .upsert({ user_id: userId, item_key: key }, {
                onConflict: 'user_id,item_key',
                ignoreDuplicates: true,
              })
          : supabase
              .from('favorites')
              .delete()
              .eq('user_id', userId)
              .eq('item_key', key)
        op.then(({ error }) => {
          if (error) console.warn('Failed to sync favorite toggle:', error.message)
        })
      }

      return next
    })
  }, [userId])

  const toggleFavorite = useCallback(item => {
    const key = favoriteKey(item)
    // Capture once per user action, outside the state updater (which React
    // re-runs under StrictMode). `signed_in` lets us split auth vs anon usage.
    captureEvent('favorite_toggled', {
      adding: !favoriteSet.has(key),
      signed_in: Boolean(userId),
    })
    writeKey(key, !favoriteSet.has(key))
  }, [userId, favoriteSet, writeKey])

  // Quietly drop an item from favorites without firing a toggle event — used
  // when an item is marked "not interested", so the two lists stay exclusive.
  const removeFavorite = useCallback(item => {
    writeKey(favoriteKey(item), false)
  }, [writeKey])

  return {
    favoriteIds,
    isFavorite,
    toggleFavorite,
    removeFavorite,
  }
}