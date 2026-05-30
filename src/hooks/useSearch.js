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
    ms.addAll(items)
    return ms
  }, [items])
}
