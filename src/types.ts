// Central type definitions for the read-model data the SPA consumes.
//
// This is the first file in the TypeScript migration (the rest of the codebase
// is still .js/.jsx with JSDoc; `// @ts-check` files reference these types via
// `import('./types.ts')`). The data originates in the Python scraper; see
// scraper/scrape.py for the source of truth on field names.

/**
 * A single auction lot, as read from a per-auction NDJSON sidecar.
 * Numeric fields arrive as plain JS numbers (NDJSON, not Arrow/BigInt).
 *
 * NOTE: `id` is NOT globally unique — it can repeat across auctions. Use
 * `${auctionSafeId}:${id}` when a globally-unique key is required.
 */
export interface Item {
  /** Maxanet/HiBid item id (unique only within an auction). */
  id: string
  lotNumber: number
  title: string
  description: string
  currentBid: number
  totalBids: number
  /** True once the auction has closed (archive step). */
  closed?: boolean
  /** Final sold/hammer price, set at close; null while live. */
  finalBid?: number | null
  /** Distinct (masked) bidders; Cannon's lots only. */
  uniqueBidders?: number
  /** Item close time (ISO or "M/D/YYYY h:mm:ss A"). */
  endDate: string
  /** S3 image URLs. */
  images: string[]
  /** Broad normalized group (e.g. "Furniture"). */
  category: string
  /** Canonical raw category (display name). */
  rawCategory: string
  detailUrl: string
  auctionId: string
  /** Filesystem-safe auction id (manifest key). */
  auctionSafeId: string
  auctionTitle: string
  auctionEndDate: string
  /** ISO 8601 UTC. */
  scrapedAt: string
  /** "cannons" or a HiBid source slug. */
  source: string
  /** Set by the loader for archived datasets. */
  archived?: boolean
}

/**
 * Auction-level metadata derived by the loader (and mirrored in the manifest).
 */
export interface Auction {
  safeId: string
  id: string
  title: string
  endDate: string
  scrapedAt: string
  source: string
  archived: boolean
  /** True when the auction is in the Richmond area. */
  isLocal: boolean
  /** Auction city, e.g. "Richmond" (for the distance filter / display). */
  city?: string
  /** Auction state abbreviation, e.g. "VA". */
  state?: string
  /**
   * Auction coordinates (geocoded city centroid) for the distance filter.
   * Optional in the type, but the scraper's geocode gate guarantees they're
   * present in practice; the distance stage treats a missing coord as
   * out-of-radius rather than crashing.
   */
  lat?: number
  lng?: number
  totalItems: number
}

/** One eBay sold comparable for an item. */
export interface EbayMatch {
  ebayItemId: string
  title: string
  price: { value: string; currency: string }
  shippingLabel?: string
  soldDate?: string
  soldDateLabel?: string
  itemWebUrl?: string
  imageUrl?: string
}

/**
 * The comp record for a single item (the value side of
 * `{ [itemId]: SoldComps }`).
 */
export interface SoldComps {
  status: 'ok' | 'no_results' | 'error'
  query?: string
  searchUrl?: string
  fetchedAt?: string
  warning?: string | null
  matches: EbayMatch[]
}

/** Filter inputs accepted by `filterItems`. */
export interface FilterOptions {
  /** rawCategory values to hide (fine-grained). */
  excludedCategories: string[]
  /** normalized group names to hide (coarse, e.g. Firearms/Vehicles). */
  excludedGroups?: string[]
  /**
   * composite item keys (`${auctionSafeId}:${id}`) to keep, or null/undefined
   * for no search filter.
   */
  searchIds?: Set<string> | null
  minPrice?: number | null
  maxPrice?: number | null
  minBids?: number | null
  maxBids?: number | null
  minBidders?: number | null
  maxBidders?: number | null
  minHours?: number | null
  maxHours?: number | null
}
