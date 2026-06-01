// Small fetch wrapper with bounded retries + exponential backoff.
//
// The read model lives on GitHub Pages / a CDN, so transient 5xx and network
// blips are the common failure mode — not application errors. We retry those a
// few times before surfacing the failure. 4xx responses (e.g. 404) are returned
// as-is so callers can decide what to do (the comps loader treats 404 as "no
// comps yet").

const DEFAULT_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 300

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function fetchWithRetry(url, {
  retries = DEFAULT_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  fetchImpl = fetch,
} = {}) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchImpl(url)
      // Retry only on server errors; client errors are returned to the caller.
      if (resp.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${resp.status}`)
      } else {
        return resp
      }
    } catch (err) {
      // Network-level failure (offline, DNS, CORS). Retry if attempts remain.
      lastError = err
      if (attempt >= retries) throw err
    }
    await sleep(baseDelayMs * 2 ** attempt)
  }
  throw lastError
}

export async function fetchJsonWithRetry(url, options) {
  const resp = await fetchWithRetry(url, options)
  if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`)
  return resp.json()
}

export async function fetchTextWithRetry(url, options) {
  const resp = await fetchWithRetry(url, options)
  if (!resp.ok) throw new Error(`Failed to load ${url}: ${resp.status}`)
  return resp.text()
}
