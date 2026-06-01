import { useMemo } from 'react'
import MiniSearch from 'minisearch'

export function useSearch(items) {
  return useMemo(() => {
    const ms = new MiniSearch({
      idField: 'id',
      fields: ['title', 'description', 'rawCategory'],
      searchOptions: {
        boost: { title: 2 },
        // No fuzzy for short words (≤5 chars) — prevents "chain" matching "chair".
        // Longer words get 1-edit fuzzy for typo tolerance.
        fuzzy: (term) => term.length > 5 ? 0.2 : 0,
        prefix: true,
      },
    })
    // Items are keyed by `id` here, but ids are only unique *within* an auction —
    // enabling archived auctions can surface two lots that share an id. MiniSearch
    // throws on duplicate ids, which (with no error boundary) would crash the whole
    // grid. De-dupe by id so the index builds; the grid still shows every lot, and
    // `searchIds.has(item.id)` matches both, so neither becomes unsearchable.
    const seen = new Set()
    const unique = items.filter(item => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    ms.addAll(unique)
    return ms
  }, [items])
}
