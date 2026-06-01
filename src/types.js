// Central JSDoc type definitions for the read-model data the SPA consumes.
//
// This file intentionally has no runtime exports — it exists so that
// `@typedef`/`@type` annotations and editors (and `// @ts-check` files) share
// one definition of the core shapes. The data originates in the Python scraper;
// see scraper/scrape.py for the source of truth on field names. A full
// TypeScript migration is tracked separately.

/**
 * A single auction lot, as read from a per-auction NDJSON sidecar.
 * Numeric fields arrive as plain JS numbers (NDJSON, not Arrow/BigInt).
 *
 * NOTE: `id` is NOT globally unique — it can repeat across auctions. Use
 * `${auctionSafeId}:${id}` when a globally-unique key is required.
 *
 * @typedef {Object} Item
 * @property {string} id            Maxanet/HiBid item id (unique only within an auction)
 * @property {number} lotNumber
 * @property {string} title
 * @property {string} description
 * @property {number} currentBid
 * @property {number} totalBids
 * @property {string} endDate       Item close time (ISO or "M/D/YYYY h:mm:ss A")
 * @property {string[]} images      S3 image URLs
 * @property {string} category      Broad normalized group (e.g. "Furniture")
 * @property {string} rawCategory   Canonical raw category (display name)
 * @property {string} detailUrl
 * @property {string} auctionId
 * @property {string} auctionSafeId Filesystem-safe auction id (manifest key)
 * @property {string} auctionTitle
 * @property {string} auctionEndDate
 * @property {string} scrapedAt     ISO 8601 UTC
 * @property {string} source        "cannons" or a HiBid source slug
 * @property {boolean} [archived]   Set by the loader for archived datasets
 */

/**
 * Auction-level metadata derived by the loader (and mirrored in the manifest).
 *
 * @typedef {Object} Auction
 * @property {string} safeId
 * @property {string} id
 * @property {string} title
 * @property {string} endDate
 * @property {string} scrapedAt
 * @property {string} source
 * @property {boolean} archived
 * @property {boolean} isLocal      True when the auction is in the Richmond area
 * @property {number} totalItems
 */

/**
 * One eBay sold comparable for an item.
 *
 * @typedef {Object} EbayMatch
 * @property {string} ebayItemId
 * @property {string} title
 * @property {{ value: string, currency: string }} price
 * @property {string} [shippingLabel]
 * @property {string} [soldDate]
 * @property {string} [soldDateLabel]
 * @property {string} [itemWebUrl]
 * @property {string} [imageUrl]
 */

/**
 * The comp record for a single item (the value side of `{ [itemId]: SoldComps }`).
 *
 * @typedef {Object} SoldComps
 * @property {'ok'|'no_results'|'error'} status
 * @property {string} [query]
 * @property {string} [searchUrl]
 * @property {string} [fetchedAt]
 * @property {?string} [warning]
 * @property {EbayMatch[]} matches
 */

/**
 * Filter inputs accepted by {@link filterItems}.
 *
 * @typedef {Object} FilterOptions
 * @property {string[]} excludedCategories  rawCategory values to hide
 * @property {?Set<string>} [searchIds]     item ids to keep, or null/undefined for no search filter
 * @property {?number} [minPrice]
 * @property {?number} [maxPrice]
 * @property {?number} [minBids]
 * @property {?number} [maxBids]
 * @property {?number} [minHours]
 * @property {?number} [maxHours]
 */

export {}
