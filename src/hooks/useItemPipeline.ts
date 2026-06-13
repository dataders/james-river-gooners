import { useMemo } from 'react'
import type { Auction, Item } from '../types.ts'
import { filterItems, getGroupedCategories } from '../utils/filters.js'
import { isDeal } from '../utils/roiCalc.js'
import { marginForItem, maxBidForItem } from '../utils/soldHistory.js'
import { itemKey } from '../utils/itemKey.js'
import { hasEbayComps } from '../utils/ebayComps.js'
import { hasCannonsComps } from '../utils/cannonsComps.js'
import { hasEnrichment } from '../utils/enrichment.js'
import { sortItems, sortByMargin, sortByMaxBid, sortByForYou } from '../utils/sort.ts'
import { useSearch } from './useSearch.js'
import { useSemanticSearch } from './useSemanticSearch.js'

/** `{ [auctionSafeId]: { [itemId]: payload } }` maps from the comps hooks. */
type ByAuction = Record<string, Record<string, unknown>>

export interface ItemPipelineInputs {
  items: Item[]
  auctions: Auction[]
  // Filter state (usePreferences + App-local toggles)
  localOnly: boolean
  searchQuery: string
  excludedCategories: string[]
  excludedGroups: string[]
  minPrice: number | null
  maxPrice: number | null
  minBids: number | null
  maxBids: number | null
  minBidders: number | null
  maxBidders: number | null
  minHours: number | null
  maxHours: number | null
  hasComp: boolean
  hasCannonsComp: boolean
  bestDeals: boolean
  showFavoritesOnly: boolean
  showIgnoredOnly: boolean
  showEnrichedOnly: boolean
  sort: string
  /** Target resale margin (%) for the max-bid sort. */
  margin: number
  // Decision predicates (stable identities from useFavorites/useIgnored)
  isFavorite: (item: Item) => boolean
  isIgnored: (item: Item) => boolean
  // Resale signals
  allComps: ByAuction
  allCannonsComps: ByAuction
  categorySoldStats: Record<string, unknown>
  /** Cannon's bid item ids (string form) from useCannonBids. */
  bidItemIds: Set<string>
  /** Per-item cosine similarity to the user's taste centroid (For You sort). */
  forYouByKey: Map<string, number>
}

/**
 * The grid's derived-data pipeline, extracted from App.jsx: locality → search
 * (keyword ∩ semantic) → range/category filters → comp/deal presence →
 * ignored/enriched/favorites views → sort. Every stage is a useMemo moved here
 * verbatim, so the reference-stability guarantees the comments call out (e.g.
 * favorite toggles not resetting ItemGrid's scroll position) are unchanged.
 * App.jsx keeps only UI state, data loading, and JSX.
 */
export function useItemPipeline({
  items,
  auctions,
  localOnly,
  searchQuery,
  excludedCategories,
  excludedGroups,
  minPrice, maxPrice,
  minBids, maxBids,
  minBidders, maxBidders,
  minHours, maxHours,
  hasComp,
  hasCannonsComp,
  bestDeals,
  showFavoritesOnly,
  showIgnoredOnly,
  showEnrichedOnly,
  sort,
  margin,
  isFavorite,
  isIgnored,
  allComps,
  allCannonsComps,
  categorySoldStats,
  bidItemIds,
  forYouByKey,
}: ItemPipelineInputs) {
  const localAuctionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const a of auctions) {
      if (a.isLocal) ids.add(a.safeId)
    }
    return ids
  }, [auctions])

  // Apply locality filter upstream so auctions list + category counts reflect it
  const visibleAuctions = useMemo(
    () => localOnly ? auctions.filter(a => a.isLocal) : auctions,
    [auctions, localOnly]
  )

  const visibleItems = useMemo(
    () => localOnly ? items.filter(item => localAuctionIds.has(item.auctionSafeId)) : items,
    [items, localOnly, localAuctionIds]
  )

  const searchIndex = useSearch(visibleItems)
  const miniSearchIds = useMemo(() => {
    if (!searchQuery) return null
    return new Set<string>(searchIndex.search(searchQuery).map((r: { id: string }) => r.id))
  }, [searchIndex, searchQuery])

  // useSemanticSearch is still untyped JS whose useState(null) seeds make TS
  // infer `null`-only fields; assert the real shape at the boundary.
  const { semanticIds, semanticStatus } = useSemanticSearch(searchQuery) as {
    semanticIds: Set<string> | null
    semanticStatus: string
  }

  // Hybrid blend: intersect when both are available so semantic filters keyword false positives.
  // If keyword finds nothing (semantic-only query like "vintage mid-century"), use semantic alone.
  // Falls back to keyword-only while the model is still loading.
  const searchIds = useMemo(() => {
    // miniSearchIds is non-null exactly when searchQuery is truthy (both memos
    // share the guard); the second check just teaches the type-checker that.
    if (!searchQuery || miniSearchIds == null) return null
    if (!semanticIds) return miniSearchIds
    if (miniSearchIds.size === 0) return semanticIds
    return new Set([...miniSearchIds].filter(id => semanticIds.has(id)))
  }, [searchQuery, miniSearchIds, semanticIds])

  // Items for range-slider histograms: search + category filtered but no range filters,
  // so slider min/max/distribution dynamically reflects the current search/category context
  // without a circular dependency between the sliders themselves.
  const rangeFilterItems = useMemo(
    () => filterItems(visibleItems, { excludedCategories, excludedGroups, searchIds }),
    [visibleItems, excludedCategories, excludedGroups, searchIds]
  )

  // Items passing price/time/bids/search but NOT category filters — for dynamic counts
  const preFilteredItems = useMemo(
    () => filterItems(visibleItems, { excludedCategories: [], searchIds, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours }),
    [visibleItems, searchIds, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours]
  )

  const groupedCategories = useMemo(() => getGroupedCategories(preFilteredItems), [preFilteredItems])

  const filteredItems = useMemo(
    () => preFilteredItems.filter((item: Item) =>
      !excludedGroups.includes(item.category) &&
      !excludedCategories.includes(item.rawCategory)
    ),
    [preFilteredItems, excludedCategories, excludedGroups]
  )

  const displayItems = useMemo(() => {
    let result = filteredItems
    if (hasComp) {
      result = result.filter((item: Item) =>
        hasEbayComps(allComps[item.auctionSafeId]?.[item.id])
      )
    }
    if (hasCannonsComp) {
      result = result.filter((item: Item) =>
        hasCannonsComps(allCannonsComps[item.auctionSafeId]?.[item.id])
      )
    }
    if (bestDeals) {
      result = result.filter((item: Item) =>
        isDeal(item.currentBid, allComps[item.auctionSafeId]?.[item.id])
      )
    }
    return result
  }, [filteredItems, hasComp, hasCannonsComp, bestDeals, allComps, allCannonsComps])

  // Base filter: applies ignored/enriched filters but NOT favorites. Kept
  // separate so a favorite toggle doesn't invalidate this memo (which would
  // produce a new array reference, reset ItemGrid's loaded count, and jump
  // the scroll position back to the top).
  const decisionFilteredItems = useMemo(() => {
    if (showIgnoredOnly) return displayItems.filter(isIgnored)
    let result = displayItems.filter((item: Item) => !isIgnored(item))
    if (showEnrichedOnly) result = result.filter(hasEnrichment)
    return result
  }, [displayItems, showIgnoredOnly, isIgnored, showEnrichedOnly])

  // Apply favorites filter only when active. When inactive, return the stable
  // decisionFilteredItems reference so downstream memos don't recalculate and
  // ItemGrid's scroll position is preserved across favorite toggles.
  const finalItems = useMemo(() => {
    if (showFavoritesOnly) return decisionFilteredItems.filter(isFavorite)
    return decisionFilteredItems
  }, [decisionFilteredItems, showFavoritesOnly, isFavorite])

  // Count bids against loaded listings only — don't count seeded bids for
  // auctions not in the read model. Computed from filteredItems (respects
  // auction/search/price/category filters but not the My Bids toggle itself).
  const cannonBidCount = useMemo(
    () => filteredItems.filter((item: Item) => bidItemIds.has(String(item.id))).length,
    [filteredItems, bidItemIds],
  )

  // Estimated profit per item ($) for the "Best margin" sort (#97): eBay comp
  // median when present, else the Cannon's category median sold (#95). Only
  // computed when that sort is active.
  const marginByKey = useMemo(() => {
    const map = new Map<string, number | null>()
    if (sort !== 'margin') return map
    for (const item of finalItems) {
      const m = marginForItem(
        item.currentBid,
        allComps[item.auctionSafeId]?.[item.id],
        categorySoldStats[item.category]
      )
      map.set(itemKey(item), m ? m.profit : null)
    }
    return map
  }, [sort, finalItems, allComps, categorySoldStats])

  // Recommended max bid per item ($) for the "Max bid" sort: resale estimate
  // (eBay comp median, else Cannon's category median) backed out through the
  // default resale margin + fees. Only computed when that sort is active.
  const maxBidByKey = useMemo(() => {
    const map = new Map<string, number | null>()
    if (sort !== 'maxbid') return map
    for (const item of finalItems) {
      map.set(itemKey(item), maxBidForItem(
        allComps[item.auctionSafeId]?.[item.id],
        categorySoldStats[item.category],
        margin / 100
      ))
    }
    return map
  }, [sort, finalItems, allComps, categorySoldStats, margin])

  const sortedItems = useMemo(() => {
    if (sort === 'margin') return sortByMargin(finalItems, marginByKey)
    if (sort === 'maxbid') return sortByMaxBid(finalItems, maxBidByKey)
    if (sort === 'foryou') return sortByForYou(finalItems, forYouByKey)
    return sortItems(finalItems, sort)
  }, [finalItems, sort, marginByKey, maxBidByKey, forYouByKey])

  return {
    visibleAuctions,
    visibleItems,
    searchIds,
    semanticStatus,
    rangeFilterItems,
    groupedCategories,
    displayItems,
    finalItems,
    sortedItems,
    cannonBidCount,
  }
}
