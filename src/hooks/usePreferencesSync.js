import { useEffect, useRef } from 'react'
import { usePreferencesStore } from '../stores/preferencesStore'
import { pickPersistedPrefs } from '../utils/prefs'
import { supabase } from '../lib/supabase'

// Account-level filter persistence (offline-first, the mirror of useFavorites /
// useIgnored for the filter config rather than a per-item list).
//
// Logged out (or Supabase not configured): no-op. localStorage stays the source
// of truth, exactly as before — the static site is unchanged.
//
// Logged in: the Supabase `filter_preferences` row (one JSONB blob per user) is
// authoritative and follows the user across devices/browsers.
//  - On first login we load the cloud row. If it exists, it takes over (applied
//    to the store + localStorage). If there's no row yet, the user's current
//    local prefs are seeded up as their account default — so a config set while
//    logged out isn't lost on first sign-in.
//  - Every subsequent persisted-field change is debounced and written back to
//    the cloud row. searchQuery is URL-only and never part of the blob.
//
// Returns nothing — it's a side-effecting sync, wired once from App alongside
// useFavorites/useIgnored.

const WRITE_DEBOUNCE_MS = 800

export function usePreferencesSync(user) {
  const userId = user?.id ?? null

  // Which user we've already loaded for — guards against a token refresh (same
  // user re-fires) re-running the load and clobbering fresh local edits.
  const loadedUserId = useRef(null)
  // The persisted slice last seen by the cloud (loaded or written), serialized.
  // The change subscriber skips writing when the slice still matches this, so a
  // just-loaded cloud blob isn't immediately echoed back.
  const lastSynced = useRef(null)
  const writeTimer = useRef(null)

  // --- Load on login / seed the cloud row ---
  useEffect(() => {
    if (!supabase || !userId) {
      loadedUserId.current = null
      lastSynced.current = null
      return
    }
    if (loadedUserId.current === userId) return
    loadedUserId.current = userId

    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('filter_preferences')
        .select('prefs')
        .eq('user_id', userId)
        .maybeSingle()
      if (cancelled) return
      if (error) {
        console.warn('Failed to load cloud filter preferences:', error.message)
        return
      }

      if (data?.prefs) {
        // Cloud wins: apply it, and record the resulting slice so the change
        // subscriber treats it as already-synced (no echo write).
        usePreferencesStore.getState().applyPrefs(data.prefs)
        lastSynced.current = JSON.stringify(pickPersistedPrefs(usePreferencesStore.getState()))
      } else {
        // No row yet — seed the current local prefs as the account default.
        const local = pickPersistedPrefs(usePreferencesStore.getState())
        lastSynced.current = JSON.stringify(local)
        const { error: seedError } = await supabase
          .from('filter_preferences')
          .upsert(
            { user_id: userId, prefs: local, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' },
          )
        if (seedError) console.warn('Failed to seed cloud filter preferences:', seedError.message)
      }
    })()

    return () => { cancelled = true }
  }, [userId])

  // --- Push persisted changes up (debounced) while logged in ---
  useEffect(() => {
    if (!supabase || !userId) return

    const flush = (slice) => {
      supabase
        .from('filter_preferences')
        .upsert(
          { user_id: userId, prefs: slice, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        )
        .then(({ error }) => {
          if (error) console.warn('Failed to sync filter preferences:', error.message)
        })
    }

    const unsubscribe = usePreferencesStore.subscribe((state) => {
      const slice = pickPersistedPrefs(state)
      const serialized = JSON.stringify(slice)
      // Only a change to a *persisted* field matters; searchQuery and friends
      // leave the slice identical, so typing never triggers a cloud write.
      if (serialized === lastSynced.current) return
      lastSynced.current = serialized
      clearTimeout(writeTimer.current)
      writeTimer.current = setTimeout(() => flush(slice), WRITE_DEBOUNCE_MS)
    })

    return () => {
      unsubscribe()
      clearTimeout(writeTimer.current)
    }
  }, [userId])
}
