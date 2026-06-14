// @ts-nocheck
// GitHub Pages / Fastly rejects URLs longer than ~4 KB with 414 URI Too Long.
// Keep well under that; localStorage carries the overflow state across reloads.
const MAX_URL_LENGTH = 2000

// Single registry of every query-string parameter the app reads or writes. The
// param *names* live here once instead of as string literals scattered across
// App.jsx, usePreferences, and useAuctionData — add a param here and reference
// it by its logical key everywhere else.
export const URL_PARAMS = {
  search: 'q',
  minPrice: 'min',
  maxPrice: 'max',
  minBids: 'minBids',
  maxBids: 'maxBids',
  minBidders: 'minBidders',
  maxBidders: 'maxBidders',
  minHours: 'minHrs',
  maxHours: 'maxHrs',
  minProfit: 'minProfit',
  excludedCategories: 'cat',
  excludedGroups: 'grp',
  localOnly: 'local',
  hasComp: 'hasComp',
  hasCannonsComp: 'hasCannonsComp',
  sort: 'sort',
  archive: 'archive',
  bestDeals: 'bestDeals',
  item: 'item',
  hideAuction: 'hideAuction',
}

// History-state marker set when we push (not replace) an entry for the open item
// detail panel, so closing it can unwind exactly that entry (browser Back too).
export const ITEM_PANEL_STATE = { goonersItemPanel: true }

export function readParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

export function readListParam(name) {
  return new URLSearchParams(window.location.search).getAll(name)
}

export function readBoolParam(name) {
  return readParam(name) === '1'
}

// Build the next URL for `key=value`, applying the same array/boolean encoding
// and length guard regardless of whether the caller replaces or pushes history.
function nextUrl(key, value) {
  const p = new URLSearchParams(window.location.search)
  if (Array.isArray(value)) {
    p.delete(key)
    for (const v of value) p.append(key, v)
  } else if (value === null || value === undefined || value === false || value === '') {
    p.delete(key)
  } else if (value === true) {
    p.set(key, '1')
  } else {
    p.set(key, String(value))
  }
  const url = new URL(window.location.href)
  url.search = p.toString()
  // If an array param bloated the URL past the safe limit, drop that key from
  // the URL (don't write a partial list — that would load wrong on reload).
  // localStorage already has the full state, so the filter keeps working.
  if (Array.isArray(value) && url.href.length > MAX_URL_LENGTH) {
    p.delete(key)
    url.search = p.toString()
  }
  return url
}

export function syncUrlParam(key, value) {
  history.replaceState(history.state, '', nextUrl(key, value))
}

// Push a *new* history entry for `key=value` (vs. syncUrlParam's in-place
// replace). Used for the item detail panel so browser Back / the close button
// dismiss it instead of leaving the page. `state` marks the entry as ours.
export function pushUrlParam(key, value, state = null) {
  history.pushState(state, '', nextUrl(key, value))
}