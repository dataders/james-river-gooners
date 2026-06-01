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
    // Item `id` is not globally unique — the same id can recur across auctions
    // (notably active vs. archived). MiniSearch throws "duplicate ID" on addAll,
    // which previously blanked the page once archived data loaded. Dedupe by id
    // (keep first) so indexing can't throw. The downstream filter/semantic
    // pipeline still keys on `id`; making search collision-correct with a
    // composite auctionSafeId:id key is tracked as a follow-up.
    const seen = new Set()
    const unique = []
    for (const item of items) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      unique.push(item)
    }
    ms.addAll(unique)
    return ms
  }, [items])
}
