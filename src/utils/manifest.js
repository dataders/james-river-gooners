export function normalizeManifest(manifest, { archived = false } = {}) {
  const defaultDir = archived ? 'data/archive/items' : 'data/items'
  const rows = Array.isArray(manifest) ? manifest : manifest?.auctions

  if (!Array.isArray(rows)) {
    throw new Error('Manifest must be an array or an object with an auctions array')
  }

  return rows.map(entry => {
    if (typeof entry === 'string') {
      return {
        safeId: entry,
        itemsPath: `${defaultDir}/${entry}.parquet`,
        archived,
      }
    }

    if (!entry?.safeId) {
      throw new Error('Manifest auction entries must include safeId')
    }

    return {
      ...entry,
      itemsPath: entry.itemsPath || `${defaultDir}/${entry.safeId}.parquet`,
      archived,
    }
  })
}
