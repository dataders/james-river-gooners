// @ts-nocheck
import { useState, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { buildEbaySoldSearchUrl } from '../utils/ebayComps'
import {
  buildFacebookMarketplaceSearchUrl,
  facebookCompsQueryFromIdentification,
} from '../utils/facebookMarketplace'

const TOP_FACEBOOK_COMPS = 8

const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const HF_TOKEN = import.meta.env.VITE_HF_TOKEN
const HF_EMBED_URL =
  'https://api-inference.huggingface.co/pipeline/feature-extraction/nomic-ai/nomic-embed-text-v1.5'

async function embedViaHF(query) {
  const headers = { 'Content-Type': 'application/json' }
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`
  const res = await fetch(HF_EMBED_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ inputs: `search_query: ${query}` }),
  })
  if (!res.ok) throw new Error(`HF API ${res.status}`)
  let vec = await res.json()
  if (Array.isArray(vec[0])) vec = vec[0]
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return norm > 0 ? vec.map(v => v / norm) : vec
}

function embedViaWorker(query) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/nomicEncoder.js', import.meta.url), {
      type: 'module',
    })
    const id = Date.now()
    worker.onmessage = (e) => {
      const { type, embedding, message } = e.data
      if (type === 'ready') {
        worker.postMessage({ type: 'encode', query, id })
        return
      }
      worker.terminate()
      if (type === 'embedding') {
        resolve(Array.from(embedding))
      } else if (type === 'error') {
        reject(new Error(message || 'Nomic embedding failed'))
      }
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('Nomic worker failed'))
    }
  })
}

async function embedTextQuery(query) {
  return isIOS ? embedViaHF(query) : embedViaWorker(query)
}

function recentTime(comp) {
  const raw = comp.sold_date || comp.last_seen_at
  const ms = raw ? new Date(raw).getTime() : 0
  return Number.isFinite(ms) ? ms : 0
}

function sortFacebookComps(comps) {
  return [...(comps || [])].sort((a, b) => {
    const sim = (b.similarity || 0) - (a.similarity || 0)
    if (Math.abs(sim) > 0.02) return sim
    return recentTime(b) - recentTime(a)
  })
}

export function useImageSearch() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const analyzeImage = useCallback(async (imageFile) => {
    if (!isSupabaseConfigured || !supabase) {
      setError('Sign in to use image search.')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const imageBase64 = await fileToBase64(imageFile)
      const mimeType = imageFile.type || 'image/jpeg'

      const { data, error: fnError } = await supabase.functions.invoke('image-search', {
        body: { imageBase64, mimeType },
      })

      if (fnError) throw new Error(fnError.message || 'Image search failed')
      if (data?.error) throw new Error(data.error)

      const identification = data

      const ebayQuery = facebookCompsQueryFromIdentification(identification)
      const ebaySearchUrl = ebayQuery ? buildEbaySoldSearchUrl(ebayQuery) : null

      const fbQuery = facebookCompsQueryFromIdentification(identification)
      const fbMarketplaceUrl = buildFacebookMarketplaceSearchUrl(fbQuery, { sold: true })

      let facebookComps = []
      if (fbQuery) {
        try {
          const queryEmbedding = await embedTextQuery(fbQuery)
          const { data: compRows, error: compError } = await supabase.rpc(
            'match_facebook_comps',
            {
              query_embedding: queryEmbedding,
              match_count: TOP_FACEBOOK_COMPS,
            }
          )
          if (compError) throw compError
          facebookComps = sortFacebookComps(compRows)
        } catch (compErr) {
          console.warn('Failed to load Facebook sold comps:', compErr)
          facebookComps = []
        }
      }

      setResult({ ...identification, ebaySearchUrl, fbMarketplaceUrl, facebookComps })
    } catch (err) {
      setError(err.message || 'Failed to analyze image')
    } finally {
      setLoading(false)
    }
  }, [])

  const clear = useCallback(() => {
    setResult(null)
    setError(null)
  }, [])

  return { analyzeImage, loading, result, error, clear }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = reader.result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
