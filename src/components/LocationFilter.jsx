// @ts-check
import { useState } from 'react'
import { RADIUS_OPTIONS } from '../utils/distance.ts'
import { lookupZip } from '../utils/geocodeZip.ts'

/** @typedef {import('../utils/distance.ts').UserLocation} UserLocation */

// Facebook-Marketplace-style location control: set a location (zip code or
// "use my current location") and a radius. Filters the grid to auctions within
// that distance. The legacy "Richmond area only" toggle remains as a separate
// source-quality filter while this ships.
/**
 * @param {{
 *   label: string,
 *   radius: number | null,
 *   onSetLocation: (location: UserLocation) => void,
 *   onRadiusChange: (radius: number | null) => void,
 * }} props
 */
export function LocationFilter({ label, radius, onSetLocation, onRadiusChange }) {
  const [zip, setZip] = useState('')
  const [status, setStatus] = useState('') // '', 'loading', 'error', 'geo-error'

  /** @param {React.FormEvent<HTMLFormElement>} e */
  async function submitZip(e) {
    e.preventDefault()
    const clean = zip.trim()
    if (!/^\d{5}$/.test(clean)) {
      setStatus('error')
      return
    }
    setStatus('loading')
    const result = await lookupZip(clean)
    if (!result) {
      setStatus('error')
      return
    }
    onSetLocation(result)
    setZip('')
    setStatus('')
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setStatus('geo-error')
      return
    }
    setStatus('loading')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onSetLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: 'Current location',
        })
        setStatus('')
      },
      () => setStatus('geo-error'),
      { timeout: 10000 }
    )
  }

  return (
    <div className="location-filter">
      <div className="lf-current">
        <span className="lf-pin" aria-hidden="true">📍</span>
        <span className="lf-label">{label}</span>
      </div>

      <form className="lf-zip-row" onSubmit={submitZip}>
        <input
          type="text"
          inputMode="numeric"
          pattern="\d{5}"
          maxLength={5}
          className="lf-zip-input"
          placeholder="Zip code"
          aria-label="Zip code"
          value={zip}
          onChange={(e) => {
            setZip(e.target.value.replace(/\D/g, '').slice(0, 5))
            if (status === 'error') setStatus('')
          }}
        />
        <button type="submit" className="lf-set-btn" disabled={status === 'loading'}>
          Set
        </button>
        <button
          type="button"
          className="lf-geo-btn"
          onClick={useMyLocation}
          disabled={status === 'loading'}
          title="Use my current location"
        >
          📍 Use my location
        </button>
      </form>

      {status === 'error' && (
        <div className="lf-error">Enter a valid 5-digit US zip code.</div>
      )}
      {status === 'geo-error' && (
        <div className="lf-error">Couldn’t get your location. Try a zip code instead.</div>
      )}

      <label className="lf-radius-row">
        <span className="fp-control-label">Within</span>
        <select
          className="lf-radius-select"
          value={radius == null ? 'any' : String(radius)}
          onChange={(e) =>
            onRadiusChange(e.target.value === 'any' ? null : Number(e.target.value))
          }
        >
          {RADIUS_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.value == null ? 'any' : String(opt.value)}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
