// Fixture dataset for the E2E suite — shaped exactly like the Supabase
// PostgREST view rows the app reads (snake_case), so the mock can serve them
// verbatim. Authored for *variety*, not volume: enough categories, a price
// spread, bidder data, a non-Richmond auction, "antique chair" matches, and an
// archived auction so the filter / search / archive / locality specs all have
// something to bite on. Counts are deliberately unpinned — every assertion in
// the suite is relative (a filter shrinks the count), so the exact numbers here
// don't matter, only the spread.
//
// A 1x1 transparent data-URI is used for every image so cards render without a
// single external network request (fast, offline, deterministic).

const IMG =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'

const PAST = '2020-01-15T18:00:00Z' // archived lots are already closed
const SCRAPED = '2026-06-13T12:00:00Z'

// End dates are computed relative to *now* (test run time) so the "Ends within"
// presets (Hour/Day/Week/Month) have a real spread to filter on. Default is far
// out (~45 days); lots pass `endHours` to land inside a tighter window.
const future = hours => new Date(Date.now() + hours * 3600 * 1000).toISOString()
const DEFAULT_END_HOURS = 24 * 45

// Build one active-card row. `images[1:1]` is already applied server-side, so a
// single-element array matches what the real _card view returns. `endHours`
// (consumed here, not emitted) sets how far out the lot's deadline is.
function lot(auction, n, over = {}) {
  const { endHours = DEFAULT_END_HOURS, ...rest } = over
  const end = future(endHours)
  return {
    auction_safe_id: auction.safe_id,
    item_id: `${auction.safe_id}-${n}`,
    lot_number: n,
    title: `Lot ${n}`,
    description: '',
    current_bid: 10,
    total_bids: 3,
    unique_bidders: 2,
    end_date: end,
    images: [IMG],
    category: 'Collectibles',
    raw_category: 'Collectibles',
    detail_url: `https://example.test/${auction.safe_id}/${n}`,
    auction_id: auction.auction_id,
    auction_title: auction.title,
    auction_city: auction.city,
    auction_state: auction.state,
    auction_latitude: auction.latitude,
    auction_longitude: auction.longitude,
    auction_end_date: end,
    scraped_at: SCRAPED,
    source: auction.source,
    ...rest,
  }
}

// --- Auctions -------------------------------------------------------------

const RICHMOND = { safe_id: 'richmond-estate', auction_id: 'A1', title: 'Richmond Estate Auction', source: 'cannons', city: 'Richmond', state: 'VA', latitude: 37.5407, longitude: -77.4360 }
const HENRICO = { safe_id: 'henrico-tools', auction_id: 'A2', title: 'Henrico Tool & Equipment Sale', source: 'hibid', city: 'Henrico', state: 'VA', latitude: 37.5059, longitude: -77.3324 }
// Lynchburg is a FAR_KEYWORD (see src/utils/locality.js) → this auction is
// NON-local, so toggling "Richmond area only" must drop its lots from the grid.
const LYNCHBURG = { safe_id: 'lynchburg-warehouse', auction_id: 'A3', title: 'Lynchburg Warehouse Liquidation', source: 'rasmus', city: 'Lynchburg', state: 'VA', latitude: 37.4138, longitude: -79.1422 }
const ARCHIVED = { safe_id: 'richmond-closed', auction_id: 'A4', title: 'Richmond Closed Estate Sale', source: 'cannons', city: 'Richmond', state: 'VA', latitude: 37.5407, longitude: -77.4360 }

// --- Active lots ----------------------------------------------------------

export const activeLots = [
  // Richmond — varied categories + price spread + the "antique chair" matches.
  lot(RICHMOND, 1, { title: 'Antique Oak Dining Chair', description: 'Solid antique chair, late 1800s', category: 'Furniture', raw_category: 'Furniture', current_bid: 45, total_bids: 8, unique_bidders: 5, endHours: 6 }),
  lot(RICHMOND, 2, { title: 'Pair of Antique Chairs', description: 'Matching antique chair set', category: 'Furniture', raw_category: 'Furniture', current_bid: 120, total_bids: 14, unique_bidders: 9, endHours: 30 }),
  lot(RICHMOND, 3, { title: 'Mahogany Dresser', category: 'Furniture', raw_category: 'Furniture', current_bid: 250, total_bids: 6, unique_bidders: 4 }),
  lot(RICHMOND, 4, { title: '14k Gold Ring', category: 'Jewelry', raw_category: 'Jewelry', current_bid: 800, total_bids: 22, unique_bidders: 12 }),
  lot(RICHMOND, 5, { title: 'Diamond Pendant Necklace', category: 'Jewelry', raw_category: 'Jewelry', current_bid: 1950, total_bids: 31, unique_bidders: 18 }),
  lot(RICHMOND, 6, { title: 'Vintage Wristwatch', category: 'Jewelry', raw_category: 'Jewelry', current_bid: 320, total_bids: 11, unique_bidders: 7 }),
  lot(RICHMOND, 7, { title: 'Royal Doulton China Set', category: 'China & Glassware', raw_category: 'China & Glassware', current_bid: 75, total_bids: 4, unique_bidders: 3 }),
  lot(RICHMOND, 8, { title: 'Crystal Decanter', category: 'China & Glassware', raw_category: 'China & Glassware', current_bid: 30, total_bids: 2, unique_bidders: 2 }),
  lot(RICHMOND, 9, { title: 'Sterling Silver Flatware', category: 'Collectibles', raw_category: 'Collectibles', current_bid: 410, total_bids: 9, unique_bidders: 6 }),
  lot(RICHMOND, 10, { title: 'Oil Painting, Landscape', category: 'Art', raw_category: 'Art', current_bid: 600, total_bids: 7, unique_bidders: 5 }),

  // Henrico — tools + electronics, lower prices.
  lot(HENRICO, 1, { title: 'DeWalt Cordless Drill', category: 'Tools', raw_category: 'Tools', current_bid: 65, total_bids: 12, unique_bidders: 8, endHours: 100 }),
  lot(HENRICO, 2, { title: 'Milwaukee Impact Driver', category: 'Tools', raw_category: 'Tools', current_bid: 90, total_bids: 15, unique_bidders: 10 }),
  lot(HENRICO, 3, { title: 'Table Saw', category: 'Tools', raw_category: 'Tools', current_bid: 180, total_bids: 5, unique_bidders: 4 }),
  lot(HENRICO, 4, { title: 'Socket Wrench Set', category: 'Tools', raw_category: 'Tools', current_bid: 25, total_bids: 3, unique_bidders: 2 }),
  lot(HENRICO, 5, { title: 'Samsung 55" TV', category: 'Electronics', raw_category: 'Electronics', current_bid: 220, total_bids: 18, unique_bidders: 11 }),
  lot(HENRICO, 6, { title: 'Bluetooth Speaker', category: 'Electronics', raw_category: 'Electronics', current_bid: 15, total_bids: 1, unique_bidders: 1 }),
  lot(HENRICO, 7, { title: 'Laptop Computer', category: 'Electronics', raw_category: 'Electronics', current_bid: 340, total_bids: 20, unique_bidders: 13 }),
  lot(HENRICO, 8, { title: 'Air Compressor', category: 'Tools', raw_category: 'Tools', current_bid: 110, total_bids: 6, unique_bidders: 5 }),

  // Lynchburg — NON-local; a handful so the locality toggle has a visible effect.
  lot(LYNCHBURG, 1, { title: 'Garden Tractor', category: 'Outdoor', raw_category: 'Outdoor', current_bid: 500, total_bids: 9, unique_bidders: 6 }),
  lot(LYNCHBURG, 2, { title: 'Patio Furniture Set', category: 'Furniture', raw_category: 'Furniture', current_bid: 130, total_bids: 4, unique_bidders: 3 }),
  lot(LYNCHBURG, 3, { title: 'Ceramic Planter', category: 'Outdoor', raw_category: 'Outdoor', current_bid: 20, total_bids: 2, unique_bidders: 2 }),
  lot(LYNCHBURG, 4, { title: 'Wheelbarrow', category: 'Tools', raw_category: 'Tools', current_bid: 35, total_bids: 3, unique_bidders: 2 }),
  lot(LYNCHBURG, 5, { title: 'Outdoor Grill', category: 'Outdoor', raw_category: 'Outdoor', current_bid: 85, total_bids: 7, unique_bidders: 5 }),
]

// --- Archived lots (closed, with final prices) ----------------------------

function archivedLot(n, over) {
  return lot(ARCHIVED, n, {
    end_date: PAST,
    auction_end_date: PAST,
    closed: true,
    final_bid: 50,
    ...over,
  })
}

export const archivedLots = [
  archivedLot(1, { title: 'Antique Writing Desk', category: 'Furniture', raw_category: 'Furniture', final_bid: 275 }),
  archivedLot(2, { title: 'Brass Floor Lamp', category: 'Furniture', raw_category: 'Furniture', final_bid: 60 }),
  archivedLot(3, { title: 'Coin Collection', category: 'Collectibles', raw_category: 'Collectibles', final_bid: 420 }),
  archivedLot(4, { title: 'Persian Rug', category: 'Furniture', raw_category: 'Furniture', final_bid: 510 }),
  archivedLot(5, { title: 'Pocket Watch', category: 'Jewelry', raw_category: 'Jewelry', final_bid: 195 }),
  archivedLot(6, { title: 'Vintage Camera', category: 'Electronics', raw_category: 'Electronics', final_bid: 80 }),
  archivedLot(7, { title: 'China Cabinet', category: 'Furniture', raw_category: 'Furniture', final_bid: 330 }),
  archivedLot(8, { title: 'Set of Tumblers', category: 'China & Glassware', raw_category: 'China & Glassware', final_bid: 25 }),
]

// --- Enrichment rows (public_lot_enrichment shape) ------------------------
// Medium/high confidence only — that's all the scraper mirrors into Supabase.
// Keyed by (auction_safe_id, item_id); the mock filters by the requested
// auction_safe_id eq-param.

export const enrichmentRows = [
  { auction_safe_id: 'henrico-tools', item_id: 'henrico-tools-1', brand: 'DeWalt', model_or_sku: 'DCD777', condition: 'used', product_url: '', confidence: 'high', model: 'claude-haiku-4-5' },
  { auction_safe_id: 'henrico-tools', item_id: 'henrico-tools-2', brand: 'Milwaukee', model_or_sku: 'M18 FUEL', condition: 'used', product_url: '', confidence: 'high', model: 'claude-haiku-4-5' },
  { auction_safe_id: 'henrico-tools', item_id: 'henrico-tools-5', brand: 'Samsung', model_or_sku: 'TU7000', condition: 'used', product_url: '', confidence: 'medium', model: 'claude-haiku-4-5' },
]

// Full-image rows for the detail panel (public_active_lots / public_archived_lots
// `select=images` by primary key). Every lot just carries two images so the
// carousel has something to page through.
export const fullImagesByKey = Object.fromEntries(
  [...activeLots, ...archivedLots].map(l => [
    `${l.auction_safe_id}:${l.item_id}`,
    [IMG, IMG],
  ])
)
