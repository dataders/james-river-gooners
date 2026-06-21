// Resolve a US zip code to coordinates for the distance filter, via the free,
// no-key, CORS-enabled Zippopotam.us service. Results are cached in localStorage
// so a repeat zip is instant and works offline. The app's default location
// (Richmond) has its coordinates baked in (see distance.ts DEFAULT_LOCATION), so
// first load needs no network call — this is only hit when the user types a zip.

import { fetchWithRetry } from './net.js'
import type { UserLocation } from './distance.ts'

const ZIPPO_BASE = 'https://api.zippopotam.us/us'
const CACHE_KEY = 'gooners-zip-cache'

type FetchLike = (url: string) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

interface LookupOptions {
  fetchImpl?: FetchLike
}

function readCache(): Record<string, UserLocation> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, UserLocation>) : {}
  } catch {
    return {}
  }
}

function writeCache(zip: string, value: UserLocation): void {
  try {
    const cache = readCache()
    cache[zip] = value
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // ignore — cache is a nicety, not required
  }
}

/**
 * Resolve a 5-digit US zip to `{ lat, lng, label }`, or `null` when the zip is
 * malformed or not found. Never throws on a bad/unknown zip — the caller shows
 * an inline "zip not found" message. Caches successful lookups in localStorage.
 */
export async function lookupZip(
  zip: string,
  { fetchImpl }: LookupOptions = {}
): Promise<UserLocation | null> {
  const clean = (zip || '').trim()
  if (!/^\d{5}$/.test(clean)) return null

  const cached = readCache()[clean]
  if (cached) return cached

  let resp
  try {
    const retryOptions = fetchImpl
      ? { fetchImpl: fetchImpl as (url: string) => Promise<Response> }
      : undefined
    resp = await fetchWithRetry(`${ZIPPO_BASE}/${clean}`, retryOptions)
  } catch {
    return null
  }
  if (!resp.ok) return null

  let data: unknown
  try {
    data = await resp.json()
  } catch {
    return null
  }

  const place = (data as { places?: Array<Record<string, string>> })?.places?.[0]
  if (!place) return null

  const lat = Number(place['latitude'])
  const lng = Number(place['longitude'])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  const name = place['place name'] || ''
  const st = place['state abbreviation'] || ''
  const label = name && st ? `${name}, ${st}` : clean

  const result: UserLocation = { lat, lng, label }
  writeCache(clean, result)
  return result
}
