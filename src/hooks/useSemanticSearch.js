import { useState, useEffect, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { compositeKey } from '../utils/itemKey'

const TOP_K = 150

// The Nomic ONNX Worker requires ~23 MB of WASM + ~40 MB of model weights.
// iOS Safari does not isolate Worker OOM from the parent WebContent process,
// so loading this in a Worker crashes the entire page.
//
// On iOS we embed the query by calling the HF Inference API directly from the
// browser (a lightweight HTTP fetch, no WASM), then call match_lots with the
// resulting vector. Set VITE_HF_TOKEN to a free HF read token for higher rate
// limits; without it the API still works but may be rate-limited at high volume.
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const HF_TOKEN = import.meta.env.VITE_HF_TOKEN
const HF_EMBED_URL =
  'https://api-inference.huggingface.co/pipeline/feature-extraction/nomic-ai/nomic-embed-text-v1.5'

async function embedViaHF(query) {
  const headers = { 'Content-Type': 'application/json' }
  if (HF_TOKEN) headers['Authorization'] = `Bearer ${HF_TOKEN}`

  const res = await fetch(HF_EMBED_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inputs: `search_query: ${query}` }),
  })
  if (!res.ok) throw new Error(`HF API ${res.status}`)

  // Feature-extraction returns [[float, ...]] for a single-string input
  let vec = await res.json()
  if (Array.isArray(vec[0])) vec = vec[0]

  // L2-normalize to match the stored item vectors
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return norm > 0 ? vec.map(v => v / norm) : vec
}

/**
 * Semantic search over Nomic embeddings.
 *
 * Desktop path: query is embedded in a Web Worker with nomic-embed-text
 * (transformers.js), then the 768-dim vector is sent to the Supabase
 * `match_lots` RPC (pgvector HNSW cosine), which returns the top-K lot keys.
 *
 * iOS path: the query is embedded via the HF Inference API (a plain HTTP
 * fetch — no WASM, no model download in the browser), then match_lots is
 * called with the resulting vector. Same result shape as desktop.
 *
 * Returns:
 *   semanticIds    — Set of composite item keys (`${safeId}:${id}`) in top-K
 *                    by similarity, or null when there's no query / no result
 *   semanticStatus — 'loading' | 'ready' | 'error'
 *
 * When Supabase is unconfigured the hook reports 'error' and stays inert.
 */
export function useSemanticSearch(query) {
  // Lazy activation: the desktop worker pulls ~23 MB of WASM + ~40 MB of model
  // weights from the HF Hub, which used to download on every page load (mount).
  // We now latch `activated` on the first non-empty query, so that cost is paid
  // only when someone actually searches — keeping it off the critical path for
  // the majority of visits that never use semantic search.
  const [activated, setActivated] = useState(Boolean(query))
  const [semanticStatus, setSemanticStatus] = useState(() => {
    if (!isSupabaseConfigured) return 'error'
    // iOS uses the HF API — no Worker warm-up, always ready.
    if (isIOS) return 'ready'
    // 'idle' until the first search; SearchBar shows no AI badge in this state.
    return query ? 'loading' : 'idle'
  })
  const [lastSemanticIds, setLastSemanticIds] = useState(null)
  const workerRef = useRef(null)
  const queryIdRef = useRef(0)

  // Flip activation on the first non-empty query (one-way latch).
  useEffect(() => {
    if (query) setActivated(true)
  }, [query])

  // Desktop: spin up the Worker once the user first searches; clean up on unmount.
  useEffect(() => {
    if (!isSupabaseConfigured || isIOS || !activated) return
    setSemanticStatus(prev => (prev === 'idle' ? 'loading' : prev))
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
      if (id !== queryIdRef.current) return

      try {
        const { data, error } = await supabase.rpc('match_lots', {
          query_embedding: Array.from(embedding),
          match_count: TOP_K,
        })
        if (error) throw error
        if (id !== queryIdRef.current) return
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
  }, [activated])

  // Desktop: re-encode whenever the query changes (or when model finishes loading).
  useEffect(() => {
    if (isIOS) return
    const worker = workerRef.current
    if (!query || !worker || semanticStatus !== 'ready') return
    const id = ++queryIdRef.current
    worker.postMessage({ type: 'encode', query, id })
  }, [query, semanticStatus])

  // iOS: embed via HF API + call match_lots directly from the browser.
  useEffect(() => {
    if (!isIOS || !isSupabaseConfigured) return
    if (!query) {
      setLastSemanticIds(null)
      return
    }
    const id = ++queryIdRef.current
    embedViaHF(query)
      .then(embedding => {
        if (id !== queryIdRef.current) return
        return supabase.rpc('match_lots', {
          query_embedding: embedding,
          match_count: TOP_K,
        })
      })
      .then(result => {
        if (!result || id !== queryIdRef.current) return
        const { data, error } = result
        if (error) throw error
        setLastSemanticIds(
          new Set((data || []).map(r => compositeKey(r.auction_safe_id, r.item_id)))
        )
      })
      .catch(err => {
        if (id !== queryIdRef.current) return
        console.warn('iOS semantic search failed:', err)
        setLastSemanticIds(null)
      })
  }, [query])

  const semanticIds = query ? lastSemanticIds : null
  return { semanticIds, semanticStatus }
}
