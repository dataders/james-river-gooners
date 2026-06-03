import { itemKey } from './itemKey.js'

export const FAVORITES_COOKIE = 'gooners-favorites'
export const FAVORITES_MAX_AGE_SECONDS = 31536000

export function favoriteKey(item) {
  return itemKey(item)
}

export function parseFavoritesCookie(cookieText = '') {
  const cookie = cookieText
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${FAVORITES_COOKIE}=`))

  if (!cookie) return []

  try {
    const value = cookie.slice(FAVORITES_COOKIE.length + 1)
    const parsed = JSON.parse(decodeURIComponent(value))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(id => typeof id === 'string')
  } catch {
    return []
  }
}

export function serializeFavoritesCookie(ids) {
  const uniqueIds = [...new Set(ids)]
  const value = encodeURIComponent(JSON.stringify(uniqueIds))
  return `${FAVORITES_COOKIE}=${value}; path=/; max-age=${FAVORITES_MAX_AGE_SECONDS}; SameSite=Lax`
}

export function toggleFavoriteKey(ids, key) {
  if (ids.includes(key)) {
    return ids.filter(id => id !== key)
  }
  return [...ids, key]
}

// Union of two key lists, de-duplicated, order-stable (first list first). Used
// on first login to merge anonymous cookie favorites into the cloud set.
export function mergeFavoriteKeys(a = [], b = []) {
  return [...new Set([...a, ...b])]
}
