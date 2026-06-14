// Normalize a read-model manifest (active or archive) into a uniform list of
// per-auction entries. Accepts both the legacy flat `string[]` form and the
// `{ auctions: [...] }` object form, and both bare safeId strings and full
// entry objects.

export interface ManifestEntry {
  safeId: string
  itemsPath: string
  archived: boolean
  ndjsonPath?: string
  // Full entries carry extra auction metadata (id/title/endDate/…) that the
  // loader reads opportunistically; keep them flowing through untouched.
  [key: string]: unknown
}

interface ManifestObjectEntry {
  safeId?: string
  itemsPath?: string
  [key: string]: unknown
}

export function normalizeManifest(
  manifest: unknown,
  { archived = false }: { archived?: boolean } = {}
): ManifestEntry[] {
  const defaultDir = archived ? 'data/archive/items' : 'data/items'
  const rows: unknown = Array.isArray(manifest)
    ? manifest
    : (manifest as { auctions?: unknown } | null)?.auctions

  if (!Array.isArray(rows)) {
    throw new Error('Manifest must be an array or an object with an auctions array')
  }

  return rows.map((entry): ManifestEntry => {
    if (typeof entry === 'string') {
      return {
        safeId: entry,
        itemsPath: `${defaultDir}/${entry}.parquet`,
        archived,
      }
    }

    const obj = entry as ManifestObjectEntry
    if (!obj?.safeId) {
      throw new Error('Manifest auction entries must include safeId')
    }

    return {
      ...obj,
      safeId: obj.safeId,
      itemsPath: obj.itemsPath || `${defaultDir}/${obj.safeId}.parquet`,
      archived,
    }
  })
}
