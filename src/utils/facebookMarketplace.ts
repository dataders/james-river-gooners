const DEFAULT_LOCATION = 'richmond'

type FacebookSearchOptions = {
  location?: string
  sold?: boolean
}

type IdentificationLike = {
  searchQuery?: string
  brand?: string
  model?: string
  searchTerms?: string
  keywords?: string[]
} | null | undefined

export function buildFacebookMarketplaceSearchUrl(
  query: string | null | undefined,
  { location = DEFAULT_LOCATION, sold = false }: FacebookSearchOptions = {},
): string | null {
  const text = String(query || '').trim()
  if (!text) return null
  const availability = sold ? 'availability=out%20of%20stock&' : ''
  return `https://www.facebook.com/marketplace/${location}/search?${availability}query=${encodeURIComponent(text)}&exact=true`
}

export function facebookCompsQueryFromIdentification(
  identification: IdentificationLike,
): string {
  return (
    identification?.searchQuery ||
    [identification?.brand, identification?.model].filter(Boolean).join(' ') ||
    identification?.searchTerms ||
    (identification?.keywords || [])[0] ||
    ''
  )
}
