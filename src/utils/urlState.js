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
  history.replaceState(null, '', url)
}
