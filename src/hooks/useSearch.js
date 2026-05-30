import { useMemo } from 'react'
import MiniSearch from 'minisearch'

export function useSearch(items) {
  return useMemo(() => {
    const ms = new MiniSearch({
      idField: 'id',
      fields: ['title', 'description', 'rawCategory'],
      searchOptions: {
        boost: { title: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    })
    ms.addAll(items)
    return ms
  }, [items])
}
