import { useState, useEffect, useRef } from 'react'
import { useEmbeddings } from './useEmbeddings'

const TOP_K = 150

function dotProductTopK(queryEmb, vectors, ids, nDims, totalItems, k) {
  const scores = new Float32Array(totalItems)
  for (let i = 0; i < totalItems; i++) {
    let dot = 0
    const base = i * nDims
    for (let j = 0; j < nDims; j++) {
      dot += queryEmb[j] * vectors[base + j]
    }
    scores[i] = dot
  }

  const indices = Array.from({ length: totalItems }, (_, i) => i)
  indices.sort((a, b) => scores[b] - scores[a])

  const result = new Set()
  for (let i = 0; i < Math.min(k, totalItems); i++) {
    result.add(ids[indices[i]])
  }
  return result
}

/**
 * Semantic search using CLIP embeddings decoded in a Web Worker.
 *
 * Returns:
 *   semanticIds   — Set of item IDs in top-K by cosine similarity, or null when no query
 *   semanticStatus — 'loading' | 'ready' | 'error'
 */
export function useSemanticSearch(query, embeddingPaths) {
  // Start in 'loading' — the worker begins downloading the model immediately on mount
  const [semanticStatus, setSemanticStatus] = useState('loading')
  const [lastSemanticIds, setLastSemanticIds] = useState(null)
  const workerRef = useRef(null)
  const queryIdRef = useRef(0)
  const embeddingsRef = useRef(null)

  const embeddings = useEmbeddings(embeddingPaths, Boolean(query))

  useEffect(() => {
    embeddingsRef.current = embeddings
  }, [embeddings])

  // Spin up the worker once on mount; clean up on unmount
  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/clipEncoder.js', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e) => {
      const { type, id, embedding } = e.data
      if (type === 'ready') {
        setSemanticStatus('ready')
      } else if (type === 'embedding') {
        if (id !== queryIdRef.current) return  // stale
        const embs = embeddingsRef.current
        if (!embs) { setLastSemanticIds(null); return }
        const { vectors, ids, nDims, totalItems } = embs
        setLastSemanticIds(dotProductTopK(embedding, vectors, ids, nDims, totalItems, TOP_K))
      } else if (type === 'error') {
        setSemanticStatus('error')
      }
    }

    worker.onerror = () => setSemanticStatus('error')
    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [])

  // Re-encode whenever the query changes (or when the model finishes loading)
  useEffect(() => {
    const worker = workerRef.current
    if (!query || !worker || semanticStatus !== 'ready') return
    const id = ++queryIdRef.current
    worker.postMessage({ type: 'encode', query, id })
  }, [query, semanticStatus])

  // When query is empty don't expose stale results from a previous search
  const semanticIds = query ? lastSemanticIds : null

  return { semanticIds, semanticStatus }
}
