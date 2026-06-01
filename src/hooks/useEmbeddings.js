import { useState, useEffect } from 'react'
import { compositeKey } from '../utils/itemKey'

const BASE = import.meta.env.BASE_URL

function dataUrl(path) {
  return `${BASE}${path.replace(/^\//, '')}`
}

async function parseEmbeddingsBuffer(buf) {
  if (buf.byteLength < 8) throw new Error('Truncated embeddings file')
  const view = new DataView(buf)
  const nItems = view.getUint32(0, true)
  const nDims = view.getUint32(4, true)
  const floatByteLen = nItems * nDims * 4
  if (buf.byteLength < 8 + floatByteLen) throw new Error('Truncated embeddings body')
  // Copy float data so the ArrayBuffer backing it can be GC'd
  const vectors = new Float32Array(buf, 8, nItems * nDims).slice()
  const ids = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8 + floatByteLen)))
  return { vectors, ids, nItems, nDims }
}

/**
 * Lazily fetches and parses embeddings files.
 * `embeddingEntries` is an array of { path, safeId } — the safeId namespaces the
 * bare item ids stored in each .embeddings binary into globally-unique composite
 * keys, since the same id recurs across auctions.
 * Returns null until active=true and all files are loaded.
 * Returns { vectors: Float32Array, ids: string[], nDims: number } when ready,
 * where `ids` are composite keys (`${safeId}:${id}`).
 */
export function useEmbeddings(embeddingEntries, active) {
  const [embeddings, setEmbeddings] = useState(null)
  const pathsKey = embeddingEntries?.map(e => e.path).join(',') ?? ''

  useEffect(() => {
    if (!active || !embeddingEntries?.length) return
    let cancelled = false

    async function load() {
      try {
        const buffers = await Promise.all(
          embeddingEntries.map(e => fetch(dataUrl(e.path)).then(r => r.arrayBuffer()))
        )
        if (cancelled) return

        const parsed = await Promise.all(buffers.map(parseEmbeddingsBuffer))
        if (cancelled) return

        const nDims = parsed[0].nDims
        const totalItems = parsed.reduce((s, p) => s + p.nItems, 0)
        const vectors = new Float32Array(totalItems * nDims)
        const ids = []
        let offset = 0
        for (let idx = 0; idx < parsed.length; idx++) {
          const { vectors: v, ids: fileIds, nItems } = parsed[idx]
          const safeId = embeddingEntries[idx].safeId
          vectors.set(v, offset * nDims)
          for (const id of fileIds) ids.push(compositeKey(safeId, id))
          offset += nItems
        }

        setEmbeddings({ vectors, ids, nDims, totalItems })
      } catch (err) {
        console.warn('Failed to load embeddings:', err)
      }
    }

    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, pathsKey])

  return embeddings
}
