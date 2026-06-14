// @ts-nocheck
import { useState, useCallback } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { buildEbaySoldSearchUrl } from '../utils/ebayComps'

const FB_MARKETPLACE_RICHMOND = 'https://www.facebook.com/marketplace/richmond/search/'

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

      const ebayQuery = [identification.brand, identification.model]
        .filter(Boolean)
        .join(' ') || identification.searchTerms || (identification.keywords || [])[0] || ''
      const ebaySearchUrl = ebayQuery ? buildEbaySoldSearchUrl(ebayQuery) : null

      const fbQuery = [identification.brand, identification.model, ...(identification.keywords || []).slice(0, 2)]
        .filter(Boolean)
        .join(' ')
      const fbMarketplaceUrl = fbQuery
        ? `${FB_MARKETPLACE_RICHMOND}?query=${encodeURIComponent(fbQuery)}`
        : null

      setResult({ ...identification, ebaySearchUrl, fbMarketplaceUrl })
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