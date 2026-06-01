import { useMemo } from 'react'
import MiniSearch from 'minisearch'
import { itemKey } from '../utils/itemKey'

export function useSearch(items) {
  return useMemo(() => {
    const ms = new MiniSearch({
      // Item `id` is not globally unique — the same id recurs across auctions
      // (active vs. archived, Maxanet vs. HiBid). Index on the auction-namespaced
      // composite key so MiniSearch.addAll can't throw "duplicate ID" and so a
      // search hit maps back to exactly one item in the filter step.
      idField: 'key',
      extractField: (doc, field) => field === 'key' ? itemKey(doc) : doc[field],
      fields: ['title', 'description', 'rawCategory'],
      searchOptions: {
        boost: { title: 2 },
        // No fuzzy for short words (≤5 chars) — prevents "chain" matching "chair".
        // Longer words get 1-edit fuzzy for typo tolerance.
        fuzzy: (term) => term.length > 5 ? 0.2 : 0,
        prefix: true,
      },
    })
    ms.addAll(items)
    return ms
  }, [items])
}
