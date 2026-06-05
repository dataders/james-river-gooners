import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { normalizeCategoryStats } from '../utils/soldHistory'

// Stable empty result for the logged-out / unconfigured path.
const EMPTY = {}

// Per-category Cannon's sold-price stats (median/range/count/recency) from the
// Supabase `public_category_sold_stats` view (#95). Fetched once on mount — the
// view has one row per category (dozens), well under PostgREST's 1000-row cap,
// so no paging is needed. A read error yields no stats rather than throwing, so
// a failure never blanks the detail panel or the margin sort.
//
// Returns { [category]: { category, soldCount, medianSold, minSold, maxSold,
// lastSoldAt } }. Empty object when Supabase isn't configured. `enabled` gates
// the read on auth — the sold-price stats are members-only (RLS, migration
// 0008), so a logged-out caller passes false to skip the fetch and clear stats.
export function useCategorySoldStats(enabled = true) {
  const [statsByCategory, setStatsByCategory] = useState({})

  useEffect(() => {
    // Logged out / unconfigured: don't fetch; the hook returns EMPTY below.
    if (!isSupabaseConfigured || !enabled) return
    let cancelled = false

    ;(async () => {
      try {
        const { data, error } = await supabase
          .from('public_category_sold_stats')
          .select('*')
        if (error) throw error
        if (cancelled) return
        const byCategory = {}
        for (const row of data || []) {
          const stats = normalizeCategoryStats(row)
          if (stats) byCategory[stats.category] = stats
        }
        setStatsByCategory(byCategory)
      } catch {
        if (!cancelled) setStatsByCategory({})
      }
    })()

    return () => { cancelled = true }
  }, [enabled])

  return enabled ? statsByCategory : EMPTY
}
