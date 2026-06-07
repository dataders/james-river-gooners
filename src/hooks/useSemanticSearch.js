import { useState, useEffect, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { compositeKey } from '../utils/itemKey'

const TOP_K = 150

// The Nomic ONNX worker requires ~23 MB of WASM + ~40 MB of model weights.
// iOS Safari does not isolate Worker memory from the parent WebContent process,
// so an OOM in the Worker crashes the entire page. Skip the worker on iOS and
// fall back to keyword-only search, which works fine on mobile.
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/**
 * Semantic search over Nomic embeddings.
 *
 * The query is embedded in a Web Worker with nomic-embed-text (transformers.js),
 * then the 768-dim vector is sent to the Supabase `match_lots` RPC, which runs
 * the pgvector HNSW cosine search server-side and returns the top-K lot keys.
 * No vectors are downloaded into the browser (the old CLIP approach fetched
 * every auction's .embeddings binary and scanned it client-side).
 *
 * Returns:
 *   semanticIds    — Set of composite item keys (`${safeId}:${id}`) in top-K by
 *                    similarity, or null when there's no query / no result
 *   semanticStatus — 'loading' | 'ready' | 'error'
 *
 * When Supabase is unconfigured or running on iOS the hook reports 'error' and
 * stays inert, so the static site and iOS browsers work (keyword search alone).
 * On other browsers the worker is lazy-loaded: it only starts when the user
 * submits a search, so casual visitors never pay the model download cost.
 */
export function useSemanticSearch(query) {
  const [semanticStatus, setSemanticStatus] = useState(
    isSupabaseConfigured && !isIOS ? 'loading' : 'error'
  )
  const [lastSemanticIds, setLastSemanticIds] = useState(null)
  const workerRef = useRef(null)
  const queryIdRef = useRef(0)
  // Latches true once a search is submitted; never resets so the worker stays
  // alive for the rest of the session.
  const [workerEnabled, setWorkerEnabled] = useState(false)

  // Latch workerEnabled on the first submitted query (non-iOS only).
  useEffect(() => {
    if (!isSupabaseConfigured || isIOS) return
    if (query && !workerEnabled) setWorkerEnabled(true)
  }, [query, workerEnabled])

  // Spin up the worker once, only after workerEnabled latches.
  useEffect(() => {
    if (!isSupabaseConfigured || isIOS || !workerEnabled) return
    const worker = new Worker(
      new URL('../workers/nomicEncoder.js', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = async (e) => {
      const { type, id, embedding } = e.data
      if (type === 'ready') {
        setSemanticStatus('ready')
        return
      }
      if (type === 'error') {
        setSemanticStatus('error')
        return
      }
      if (type !== 'embedding') return
      if (id !== queryIdRef.current) return // stale query

      try {
        const { data, error } = await supabase.rpc('match_lots', {
          query_embedding: Array.from(embedding),
          match_count: TOP_K,
        })
        if (error) throw error
        if (id !== queryIdRef.current) return // a newer query landed during the await
        setLastSemanticIds(
          new Set((data || []).map(r => compositeKey(r.auction_safe_id, r.item_id)))
        )
      } catch (err) {
        console.warn('match_lots RPC failed:', err)
        setLastSemanticIds(null)
      }
    }

    worker.onerror = () => setSemanticStatus('error')
    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [workerEnabled])

  // Re-encode whenever the query changes (or when the model finishes loading).
  useEffect(() => {
    const worker = workerRef.current
    if (!query || !worker || semanticStatus !== 'ready') return
    const id = ++queryIdRef.current
    worker.postMessage({ type: 'encode', query, id })
  }, [query, semanticStatus])

  // When query is empty don't expose stale results from a previous search.
  const semanticIds = query ? lastSemanticIds : null

  return { semanticIds, semanticStatus }
}
