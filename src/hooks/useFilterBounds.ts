import { useEffect, useState } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

export interface FilterBounds {
  priceP99: number
  bidsP99: number
  biddersP99: number
}

// Global 99th-percentile bounds for the price/bidding sliders, fetched once from
// a cheap server aggregate (get_active_lot_filter_bounds). The browser loads lots
// progressively from a biased first page, so client-derived bounds are wrong and
// jumpy until the whole set lands; these give the slider tracks correct, stable
// maxes from first paint. null until loaded (and when Supabase is unconfigured),
// in which case RangeFilters falls back to its client-side p99 over loaded items.
export function useFilterBounds(): FilterBounds | null {
  const [bounds, setBounds] = useState<FilterBounds | null>(null)

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return
    let cancelled = false
    supabase
      .rpc('get_active_lot_filter_bounds')
      .single<{ price_p99: number; bids_p99: number; bidders_p99: number }>()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setBounds({
          priceP99: Number(data.price_p99) || 0,
          bidsP99: Number(data.bids_p99) || 0,
          biddersP99: Number(data.bidders_p99) || 0,
        })
      })
    return () => { cancelled = true }
  }, [])

  return bounds
}
