// @ts-nocheck
import { useState, useEffect } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

// The browsing grid loads a thumbnail-only image set (just images[0]) from the
// _card views for speed; the detail panel's carousel needs the full set. When a
// lot is opened, fetch its complete images[] by primary key from the full lots
// view and swap it in. Falls back to whatever images the item already carries
// (the thumbnail, or the full set on the offline NDJSON path where nothing is
// trimmed and Supabase isn't configured).
//
// Pass `triggered: false` to defer the fetch until an external signal is true
// (e.g. on first hover or first touch in a card carousel). Defaults to true so
// existing callers (ItemDetail) are unchanged.
export function useFullImages(item, { triggered = true } = {}) {
  const itemImages = item?.images || []
  const key = item ? `${item.auctionSafeId || ''}:${item.id}` : null
  // Tag the fetched set with the lot it belongs to. When a different lot is
  // opened the keys no longer match, so we fall back to that lot's thumbnail
  // until its own fetch resolves — no stale carousel, and no setState in the
  // effect body just to reset.
  const [fetched, setFetched] = useState(null)

  useEffect(() => {
    if (!triggered || !isSupabaseConfigured || !item) return
    let cancelled = false
    const run = async () => {
      // An active lot can be flagged archived dynamically (its deadline passed)
      // while still living in the active view, so try the view its flag points
      // to first, then fall back to the other.
      const views = item.archived
        ? ['public_archived_lots', 'public_active_lots']
        : ['public_active_lots', 'public_archived_lots']
      for (const view of views) {
        const { data, error } = await supabase
          .from(view)
          .select('images')
          .eq('auction_safe_id', item.auctionSafeId)
          .eq('item_id', String(item.id))
          .maybeSingle()
        if (cancelled) return
        if (!error && data?.images?.length) {
          setFetched({ key, images: data.images })
          return
        }
      }
    }
    run()
    return () => { cancelled = true }
  }, [triggered, item, key])

  return fetched && fetched.key === key ? fetched.images : itemImages
}
