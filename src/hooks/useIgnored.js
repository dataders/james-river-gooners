import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ignoredKey,
  mergeIgnoredKeys,
  parseIgnoredCookie,
  serializeIgnoredCookie,
  toggleIgnoredKey,
} from '../utils/ignored'
import { supabase } from '../lib/supabase'
import { captureEvent } from '../lib/telemetry'

function loadIgnoredIds() {
  if (typeof document === 'undefined') return []
  return parseIgnoredCookie(document.cookie)
}

function saveIgnoredIds(ids) {
  if (typeof document === 'undefined') return
  document.cookie = serializeIgnoredCookie(ids)
}

// Cloud "not interested" list, offline-first. A direct mirror of useFavorites:
//
// Logged out (or Supabase not configured): the `gooners-ignored` cookie is the
// source of truth.
//
// Logged in: the Supabase `ignored` table is authoritative. On first login we
// merge the anonymous cookie ignores into the cloud set (union) and push any
// cookie-only keys up. Toggles are optimistic — local state updates immediately,
// the network write follows. The cookie is kept as a mirror so ignores still
// take effect instantly on reload and survive going offline.
export function useIgnored(user) {
  const [ignoredIds, setIgnoredIds] = useState(loadIgnoredIds)
  const ignoredSet = useMemo(() => new Set(ignoredIds), [ignoredIds])

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
      const localIds = loadIgnoredIds()
      const { data, error } = await supabase
        .from('ignored')
        .select('item_key')
        .eq('user_id', userId)
      if (cancelled || error) {
        if (error) console.warn('Failed to load cloud ignores:', error.message)
        return
      }

      const cloudIds = data.map(row => row.item_key)
      const merged = mergeIgnoredKeys(cloudIds, localIds)

      const toInsert = localIds.filter(id => !cloudIds.includes(id))
      if (toInsert.length) {
        const { error: insertError } = await supabase
          .from('ignored')
          .upsert(
            toInsert.map(item_key => ({ user_id: userId, item_key })),
            { onConflict: 'user_id,item_key', ignoreDuplicates: true },
          )
        if (insertError) console.warn('Failed to sync local ignores up:', insertError.message)
      }

      if (cancelled) return
      setIgnoredIds(merged)
      saveIgnoredIds(merged)
    })()

    return () => { cancelled = true }
  }, [userId])

  const isIgnored = useCallback(
    item => ignoredSet.has(ignoredKey(item)),
    [ignoredSet],
  )

  // Add/remove `key` and fire the matching cloud write. Returns the next id list.
  const writeKey = useCallback((key, shouldIgnore) => {
    setIgnoredIds(prev => {
      const has = prev.includes(key)
      if (has === shouldIgnore) return prev
      const next = toggleIgnoredKey(prev, key)
      saveIgnoredIds(next)

      if (supabase && userId) {
        const op = shouldIgnore
          ? supabase
              .from('ignored')
              .upsert({ user_id: userId, item_key: key }, {
                onConflict: 'user_id,item_key',
                ignoreDuplicates: true,
              })
          : supabase
              .from('ignored')
              .delete()
              .eq('user_id', userId)
              .eq('item_key', key)
        op.then(({ error }) => {
          if (error) console.warn('Failed to sync ignore toggle:', error.message)
        })
      }

      return next
    })
  }, [userId])

  const toggleIgnored = useCallback(item => {
    const key = ignoredKey(item)
    // Capture once per user action, outside the state updater (which React
    // re-runs under StrictMode). `signed_in` splits auth vs anon usage.
    captureEvent('ignored_toggled', {
      adding: !ignoredSet.has(key),
      signed_in: Boolean(userId),
    })
    writeKey(key, !ignoredSet.has(key))
  }, [userId, ignoredSet, writeKey])

  // Quietly drop an item from the ignore list without firing a toggle event —
  // used when an item is favorited, so the two lists stay mutually exclusive.
  const removeIgnored = useCallback(item => {
    writeKey(ignoredKey(item), false)
  }, [writeKey])

  return {
    ignoredIds,
    isIgnored,
    toggleIgnored,
    removeIgnored,
  }
}
