// Great-circle distance + the location-filter constants for the
// Facebook-Marketplace-style "within N miles of a location" filter.

const EARTH_RADIUS_MILES = 3958.8

const toRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * Great-circle distance between two lat/lng points, in miles (Haversine).
 * Precise enough for a city-centroid radius filter (sub-percent error at these
 * distances), and cheap enough to run per-auction on every filter pass.
 */
export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** A user-selectable location for the distance filter. */
export interface UserLocation {
  lat: number
  lng: number
  label: string
}

/**
 * Out-of-the-box location: Richmond, VA. The app opens centered here with the
 * 25-mile default radius, preserving the old "Richmond area" experience while
 * letting users widen the radius or set their own location.
 */
export const DEFAULT_LOCATION: UserLocation = {
  lat: 37.538509,
  lng: -77.43428,
  label: 'Richmond, VA',
}

/** Default radius (miles) — roughly the old Richmond-area footprint. */
export const DEFAULT_RADIUS_MILES = 25

/**
 * Radius dropdown options. `null` means "Any distance" — the distance filter is
 * disabled and every auction passes regardless of location.
 */
export const RADIUS_OPTIONS: ReadonlyArray<{ value: number | null; label: string }> = [
  { value: 25, label: '25 miles' },
  { value: 50, label: '50 miles' },
  { value: 100, label: '100 miles' },
  { value: 250, label: '250 miles' },
  { value: 500, label: '500 miles' },
  { value: null, label: 'Any distance' },
]
