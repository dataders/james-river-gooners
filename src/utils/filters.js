// @ts-check
/** @typedef {import('../types.ts').Item} Item */
/** @typedef {import('../types.ts').FilterOptions} FilterOptions */

import { parseAuctionDate } from './dates.js'
import { itemKey } from './itemKey.js'

/**
 * Hours from now until an item closes; Infinity when there is no end date.
 * @param {string} endDate
 * @returns {number}
 */
function hoursUntil(endDate) {
  const end = parseAuctionDate(endDate)
  if (!end) return Infinity
  return Math.max(0, (end.getTime() - Date.now()) / 3600000)
}

/**
 * Filter auction items based on preferences.
 * excludedCategories holds rawCategory values (fine-grained); excludedGroups
 * holds normalized group names (coarse — e.g. Firearms/Vehicles hidden by
 * default), matched against item.category.
 *
 * @param {Item[]} items
 * @param {FilterOptions} options
 * @returns {Item[]}
 */
export function filterItems(items, { excludedCategories, excludedGroups = [], searchIds, minPrice, maxPrice, minBids, maxBids, minBidders, maxBidders, minHours, maxHours }) {
  return items.filter(item => {
    // Exclude filter: hide items by normalized group (coarse) or rawCategory (fine)
    if (excludedGroups.includes(item.category)) {
      return false
    }
    if (excludedCategories.includes(item.rawCategory)) {
      return false
    }

    // Price filter
    if (minPrice != null && item.currentBid < minPrice) {
      return false
    }
    if (maxPrice != null && item.currentBid > maxPrice) {
      return false
    }

    // Bids filter
    if (minBids != null && item.totalBids < minBids) {
      return false
    }
    if (maxBids != null && item.totalBids > maxBids) {
      return false
    }

    // Bidders filter — uniqueBidders is absent on sources that don't expose
    // bidder identities (e.g. HiBid), so treat missing as 0.
    if (minBidders != null || maxBidders != null) {
      const bidders = item.uniqueBidders ?? 0
      if (minBidders != null && bidders < minBidders) return false
      if (maxBidders != null && bidders > maxBidders) return false
    }

    // Time filter
    if (minHours != null || maxHours != null) {
      const h = hoursUntil(item.endDate)
      if (minHours != null && h < minHours) return false
      if (maxHours != null && h > maxHours) return false
    }

    // Search filter — searchIds holds globally-unique composite keys, since a
    // bare item id can collide across auctions and match the wrong lot.
    if (searchIds !== null && searchIds !== undefined && !searchIds.has(itemKey(item))) {
      return false
    }

    return true
  })
}

/**
 * Get raw categories grouped under their normalized group, with counts.
 * Returns: [{ group: "Electronics", rawCategories: [{ name: "Audiovisual", count: 22 }, ...] }, ...]
 *
 * @param {Item[]} items
 * @returns {{ group: string, rawCategories: { name: string, count: number }[], totalCount: number }[]}
 */
export function getGroupedCategories(items) {
  /** @typedef {{ group: string, rawCategories: { name: string, count: number }[], totalCount: number }} CategoryGroup */
  // Count raw categories
  /** @type {Record<string, number>} */
  const rawCounts = {}
  /** @type {Record<string, string>} */
  const rawToGroup = {}
  for (const item of items) {
    const raw = item.rawCategory || 'Other'
    rawCounts[raw] = (rawCounts[raw] || 0) + 1
    if (!rawToGroup[raw]) {
      rawToGroup[raw] = item.category || 'Other'
    }
  }

  // Group by normalized category
  /** @type {Record<string, CategoryGroup>} */
  const groups = {}
  for (const [raw, count] of Object.entries(rawCounts)) {
    // rawToGroup[raw] is set for every key in rawCounts (same loop above), but
    // noUncheckedIndexedAccess widens the read to `string | undefined`.
    const group = rawToGroup[raw] ?? 'Other'
    if (!groups[group]) {
      groups[group] = { group, rawCategories: [], totalCount: 0 }
    }
    groups[group].rawCategories.push({ name: raw, count })
    groups[group].totalCount += count
  }

  // Sort groups by total count, sort raw categories within each group
  return Object.values(groups)
    .sort((a, b) => b.totalCount - a.totalCount)
    .map(g => ({
      ...g,
      rawCategories: g.rawCategories.sort((a, b) => b.count - a.count),
    }))
}
