// @ts-nocheck
// Pure normalizers for the browser read model.
// No Vite / browser dependencies so these can be unit-tested with plain Node.

import { isLocalAuction } from './locality.js'

// --- Supabase path ---

// Map a snake_case Supabase lots-view row to the shared Item shape.
export function normalizeLotRow(row) {
  return {
    id: row.item_id,
    lotNumber: row.lot_number,
    title: row.title,
    description: row.description,
    currentBid: row.current_bid != null ? Number(row.current_bid) : 0,
    totalBids: row.total_bids ?? 0,
    uniqueBidders: row.unique_bidders ?? 0,
    endDate: row.end_date,
    images: row.images ?? [],
    category: row.category,
    rawCategory: row.raw_category,
    detailUrl: row.detail_url,
    auctionId: row.auction_id,
    auctionSafeId: row.auction_safe_id,
    auctionTitle: row.auction_title,
    auctionEndDate: row.auction_end_date,
    scrapedAt: row.scraped_at,
    source: row.source,
    ...(row.final_bid != null ? { finalBid: Number(row.final_bid) } : {}),
    ...(row.closed != null ? { closed: row.closed } : {}),
  }
}

export function normalizeRowsSupabase(rows, archived) {
  const items = []
  const auctionMap = {}
  for (const row of rows) {
    const item = { ...normalizeLotRow(row), archived }
    items.push(item)
    const sid = item.auctionSafeId
    if (sid && !auctionMap[sid]) {
      auctionMap[sid] = {
        safeId: sid,
        id: item.auctionId,
        title: item.auctionTitle,
        endDate: item.auctionEndDate,
        scrapedAt: item.scrapedAt,
        source: item.source || 'cannons',
        archived,
        isLocal: isLocalAuction(item.auctionTitle),
        totalItems: 0,
      }
    }
    if (sid) auctionMap[sid].totalItems++
  }
  return { items, auctions: Object.values(auctionMap) }
}