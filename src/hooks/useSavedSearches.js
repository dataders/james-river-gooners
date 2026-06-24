// @ts-check
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { pickPersistedPrefs } from '../utils/prefs'
import { usePreferencesStore } from '../stores/preferencesStore'

/**
 * @typedef {{ id: string, name: string, filters: Record<string, unknown>, created_at: string }} SavedSearch
 */

/**
 * Load, save, delete, and apply named filter presets from the `saved_searches`
 * Supabase table. Auth-gated: returns empty when logged out or Supabase is not
 * configured.
 *
 * @param {{ id: string } | null} user
 */
export function useSavedSearches(user) {
  const [searches, setSearches] = useState(/** @type {SavedSearch[]} */ ([]))
  const userId = user?.id ?? null

  useEffect(() => {
    if (!supabase || !userId) {
      setSearches([])
      return
    }
    let cancelled = false
    supabase
      .from('saved_searches')
      .select('id, name, filters, created_at')
      .eq('user_id', userId)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) { console.warn('Failed to load saved searches:', error.message); return }
        setSearches(/** @type {SavedSearch[]} */ (/** @type {unknown} */ (data ?? [])))
      })
    return () => { cancelled = true }
  }, [userId])

  const saveSearch = useCallback((/** @type {string} */ name) => {
    if (!supabase || !userId || !name.trim()) return
    const filters = pickPersistedPrefs(usePreferencesStore.getState())
    supabase
      .from('saved_searches')
      .upsert(
        { user_id: userId, name: name.trim(), filters },
        { onConflict: 'user_id,name' },
      )
      .select('id, name, filters, created_at')
      .single()
      .then(({ data, error }) => {
        if (error) { console.warn('Failed to save search:', error.message); return }
        const saved = /** @type {SavedSearch} */ (/** @type {unknown} */ (data))
        setSearches(prev => {
          const without = prev.filter(s => s.name !== saved.name)
          return [...without, saved].sort((a, b) => a.name.localeCompare(b.name))
        })
      })
  }, [userId])

  const deleteSearch = useCallback((/** @type {string} */ id) => {
    if (!supabase || !userId) return
    setSearches(prev => prev.filter(s => s.id !== id))
    supabase
      .from('saved_searches')
      .delete()
      .eq('id', id)
      .eq('user_id', userId)
      .then(({ error }) => {
        if (error) console.warn('Failed to delete saved search:', error.message)
      })
  }, [userId])

  const loadSearch = useCallback((/** @type {SavedSearch} */ search) => {
    usePreferencesStore.getState().applyPrefs(search.filters)
  }, [])

  return { searches, saveSearch, deleteSearch, loadSearch }
}
