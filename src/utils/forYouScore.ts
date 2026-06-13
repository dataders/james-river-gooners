import type { Item } from '../types.ts'
import { itemKey } from './itemKey.js'

interface Profile {
  categories: Map<string, number>
  brands: Map<string, number>
  avgPrice: number | null
}

function buildProfile(items: Item[]): Profile {
  const categories = new Map<string, number>()
  const brands = new Map<string, number>()
  let totalPrice = 0
  let priceCount = 0
  for (const item of items) {
    if (item.category) categories.set(item.category, (categories.get(item.category) ?? 0) + 1)
    const brand = ((item as Record<string, unknown>).brand as string | undefined)?.toLowerCase()
    if (brand) brands.set(brand, (brands.get(brand) ?? 0) + 1)
    if (item.currentBid > 0) { totalPrice += item.currentBid; priceCount++ }
  }
  return { categories, brands, avgPrice: priceCount ? totalPrice / priceCount : null }
}

/**
 * Score each item by how well it matches the user's revealed preferences
 * (bid history weighted 3×, favorites 2× for category; 2×/1× for brand).
 * Price proximity to the user's typical bid range adds a small continuous boost.
 * Returns a map from itemKey → score (higher = better match).
 */
export function buildForYouScores(
  items: Item[],
  favoriteItems: Item[],
  bidItems: Item[],
): Map<string, number> {
  const fav = buildProfile(favoriteItems)
  const bid = buildProfile(bidItems)
  const map = new Map<string, number>()

  for (const item of items) {
    let score = 0

    const cat = item.category
    if (cat) {
      score += (bid.categories.get(cat) ?? 0) * 3
      score += (fav.categories.get(cat) ?? 0) * 2
    }

    const brand = ((item as Record<string, unknown>).brand as string | undefined)?.toLowerCase()
    if (brand) {
      score += (bid.brands.get(brand) ?? 0) * 2
      score += (fav.brands.get(brand) ?? 0) * 1
    }

    // Price proximity: smooth bell centred on the user's avg bid/fav price.
    const avgPrice = bid.avgPrice ?? fav.avgPrice
    if (avgPrice != null && item.currentBid > 0) {
      score += Math.exp(-Math.abs(Math.log(item.currentBid / avgPrice)) * 1.5)
    }

    map.set(itemKey(item), score)
  }
  return map
}
