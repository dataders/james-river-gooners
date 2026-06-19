// @ts-nocheck
import { itemKey } from './itemKey.js'

// Mirrors src/utils/favorites.js — the "not interested" list. Same composite
// item key, same cookie shape, just a different cookie name so favorites and
// ignores never collide in storage.
const IGNORED_COOKIE = 'gooners-ignored'
const IGNORED_MAX_AGE_SECONDS = 31536000

export function ignoredKey(item) {
  return itemKey(item)
}

export function parseIgnoredCookie(cookieText = '') {
  const cookie = cookieText
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${IGNORED_COOKIE}=`))

  if (!cookie) return []

  try {
    const value = cookie.slice(IGNORED_COOKIE.length + 1)
    const parsed = JSON.parse(decodeURIComponent(value))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(id => typeof id === 'string')
  } catch {
    return []
  }
}

export function serializeIgnoredCookie(ids) {
  const uniqueIds = [...new Set(ids)]
  const value = encodeURIComponent(JSON.stringify(uniqueIds))
  return `${IGNORED_COOKIE}=${value}; path=/; max-age=${IGNORED_MAX_AGE_SECONDS}; SameSite=Lax`
}

export function toggleIgnoredKey(ids, key) {
  if (ids.includes(key)) {
    return ids.filter(id => id !== key)
  }
  return [...ids, key]
}

// Union of two key lists, de-duplicated, order-stable (first list first). Used
// on first login to merge anonymous cookie ignores into the cloud set.
export function mergeIgnoredKeys(a = [], b = []) {
  return [...new Set([...a, ...b])]
}