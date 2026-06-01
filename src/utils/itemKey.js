// @ts-check
/** @typedef {import('../types.js').Item} Item */

// Item `id` is unique only within a single auction — the same id recurs across
// auctions (notably active vs. archived, and across source sites like Maxanet
// vs. HiBid). Anywhere item identity is compared globally (search index,
// filter, semantic results, deep-link, cross-snapshot de-dupe) must key on the
// auction-namespaced composite, not the bare id.

/**
 * Globally-unique key from an auction safeId and an item id.
 * @param {string} auctionSafeId
 * @param {string|number} id
 * @returns {string}
 */
export function compositeKey(auctionSafeId, id) {
  return `${auctionSafeId}:${id}`
}

/**
 * Globally-unique key for an auction item.
 * @param {Item} item
 * @returns {string}
 */
export function itemKey(item) {
  return compositeKey(item.auctionSafeId, item.id)
}
