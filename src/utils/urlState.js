// GitHub Pages / Fastly rejects URLs longer than ~4 KB with 414 URI Too Long.
// Keep well under that; localStorage carries the overflow state across reloads.
const MAX_URL_LENGTH = 2000

export function syncUrlParam(key, value) {
  const p = new URLSearchParams(window.location.search)
  if (Array.isArray(value)) {
    p.delete(key)
    for (const v of value) p.append(key, v)
  } else if (value === null || value === undefined || value === false || value === '') {
    p.delete(key)
  } else if (value === true) {
    p.set(key, '1')
  } else {
    p.set(key, String(value))
  }
  const url = new URL(window.location.href)
  url.search = p.toString()
  // If an array param bloated the URL past the safe limit, drop that key from
  // the URL (don't write a partial list — that would load wrong on reload).
  // localStorage already has the full state, so the filter keeps working.
  if (Array.isArray(value) && url.href.length > MAX_URL_LENGTH) {
    p.delete(key)
    url.search = p.toString()
  }
  history.replaceState(null, '', url)
}
