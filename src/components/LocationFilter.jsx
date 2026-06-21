// @ts-check
import { useState } from 'react'
import { RADIUS_OPTIONS } from '../utils/distance.ts'
import { lookupZip } from '../utils/geocodeZip.ts'

/** @typedef {import('../utils/distance.ts').UserLocation} UserLocation */

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
  const [editing, setEditing] = useState(false)

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
    setEditing(false)
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
        setEditing(false)
      },
      () => setStatus('geo-error'),
      { timeout: 10000 }
    )
  }

  return (
    <div className="location-filter">
      <div className="lf-summary">
        <span className="lf-pin" aria-hidden="true">📍</span>
        <span className="lf-label">{label}</span>
        <select
          className="lf-radius-select lf-radius-select--inline"
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
        <button
          type="button"
          className="lf-change-btn"
          onClick={() => { setEditing(v => !v); setStatus('') }}
        >
          {editing ? 'Done' : 'Change'}
        </button>
      </div>

      {editing && (
        <>
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
            <div className="lf-error">Couldn't get your location. Try a zip code instead.</div>
          )}
        </>
      )}
    </div>
  )
}
