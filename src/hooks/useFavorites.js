import { useCallback, useMemo, useState } from 'react'
import {
  favoriteKey,
  parseFavoritesCookie,
  serializeFavoritesCookie,
  toggleFavoriteKey,
} from '../utils/favorites'

function loadFavoriteIds() {
  if (typeof document === 'undefined') return []
  return parseFavoritesCookie(document.cookie)
}

function saveFavoriteIds(ids) {
  if (typeof document === 'undefined') return
  document.cookie = serializeFavoritesCookie(ids)
}

export function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useState(loadFavoriteIds)
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds])

  const isFavorite = useCallback(
    item => favoriteSet.has(favoriteKey(item)),
    [favoriteSet],
  )

  const toggleFavorite = useCallback(item => {
    const key = favoriteKey(item)
    setFavoriteIds(prev => {
      const next = toggleFavoriteKey(prev, key)
      saveFavoriteIds(next)
      return next
    })
  }, [])

  return {
    favoriteIds,
    isFavorite,
    toggleFavorite,
  }
}
