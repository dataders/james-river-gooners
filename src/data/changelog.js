// Single source of truth for the in-app "What's New" feed and CHANGELOG.md.
// Newest release first. Each change carries a stable, unique `id`: useWhatsNew
// tracks which individual lines a visitor has already seen by that id, so a new
// line flags "New" even when added to an existing day. NEVER reuse or rename an
// id (that would mark the line seen/unseen for the wrong people) — pick a fresh
// slug for every new line. Keep wording user-facing: describe what changed for
// someone browsing auctions, not the implementation.

export const CHANGELOG = [
  {
    date: '2026-06-13',
    title: 'Your filters follow your account',
    changes: [
      { id: 'filter-account-sync', icon: '🔒', text: 'When you\'re signed in, your filters — hidden categories, price and bid ranges, sort and layout — now save to your account and follow you across devices. Hide Coins, Silver and Jewelry once and they stay hidden everywhere you log in.' },
    ],
  },
  {
    date: '2026-06-13',
    title: 'Easier price & bidding filters',
    changes: [
      { id: 'range-sliders-touch', icon: '🎚', text: 'The Price, Bids and Bidders sliders are much easier to grab and drag now — especially on a phone, where the handles were fiddly to hit before.' },
      { id: 'ends-within-presets', icon: '⏰', text: 'The "Ends within" filter is now simple quick buttons — 1 hour, 1 day, 1 week, 1 month, or All — instead of a fiddly time slider.' },
      { id: 'slider-bounds-stable', icon: '🎯', text: 'The price and bidding sliders now show their correct range right away instead of starting too small and shifting as more lots load in.' },
    ],
  },
  {
    date: '2026-06-13',
    title: 'Snappier browsing',
    changes: [
      { id: 'perf-faster-first-load', icon: '⚡', text: 'The site now loads noticeably faster the first time you open it — the heavy AI-search model only downloads once you actually use search, instead of on every visit.' },
      { id: 'perf-smoother-scrolling', icon: '🧈', text: 'Scrolling through thousands of lots is smoother now, and typing in search or dragging the filter sliders no longer makes the grid stutter.' },
      { id: 'nav-back-closes-item', icon: '⬅️', text: 'Pressing your browser or phone Back button now closes an open item instead of leaving the site.' },
      { id: 'filter-counts-match-archive', icon: '🔢', text: 'The Favorites and Ignored counts in the filter menu now match what you actually see — they reflect the active/archived auctions currently loaded, instead of always showing your all-time total.' },
      { id: 'ended-shows-close-time', icon: '🕐', text: 'Lots that have closed now show when they ended (e.g. "Ended Jun 11, 7:56 PM") instead of just "Ended" — handy when a lot finishes early while the rest of its auction is still running.' },
      { id: 'cat-whole-vehicles', icon: '🚗', text: 'Whole cars, trucks and motorcycles now land in the Vehicles category, so hiding Vehicles actually hides them — previously they slipped into "Other" and kept showing up.' },
      { id: 'cat-other-cleanup', icon: '🗂️', text: 'Hundreds of lots that were dumped in "Other" — sports cards, coins, rugs, die-cast toys, cast-iron & enamelware, stamps, vintage advertising — now sort into their proper categories, so browsing and filtering by category is much more accurate.' },
      { id: 'cat-pet-adoption', icon: '🐾', text: 'Added a dedicated Pet Adoption category for the live animals listed for adoption, so they\'re easy to find — or hide.' },
      { id: 'ended-lots-hidden', icon: '🧹', text: 'Lots that have already closed are now hidden from the main grid by default — even when the rest of their auction is still live and staggering lots shut over several days. Flip on "All auctions" to bring ended lots (and their final prices) back into view.' },
    ],
  },
  {
    date: '2026-06-09',
    title: 'Faster loading',
    changes: [
      { id: 'faster-load-progressive', icon: '⚡', text: 'The auction grid now appears in a couple of seconds and fills in the rest of the lots as they load, instead of sitting on a "Fetching auction data" spinner until everything is ready.' },
    ],
  },
  {
    date: '2026-06-08',
    title: 'Bid status notifications',
    changes: [
      { id: 'bid-alert-badge', icon: '🔴', text: 'A red badge now appears on the account icon when you\'ve been outbid on any active item — tap your profile to see what\'s changed.' },
      { id: 'bid-outbid-highlight', icon: '📋', text: 'Outbid items are now highlighted with a red left border in My Bids so they jump out at a glance.' },
      { id: 'bid-checked-time', icon: '🕐', text: 'Each item in My Bids now shows when its status was last checked, so you know exactly how fresh the winning/outbid information is.' },
      { id: 'bid-poll-faster', icon: '⚡', text: 'Bid statuses now refresh every minute (was every 2 minutes) while the page is open.' },
    ],
  },
  {
    date: '2026-06-08',
    title: 'My Bids panel & live bid prices',
    changes: [
      { id: 'my-bids-panel', icon: '🏷', text: 'My Bids is now a history panel instead of a grid filter — it shows all your bids (including from ended auctions) with winning/outbid/closed status and current prices in one place.' },
      { id: 'bid-price-live-display', icon: '💰', text: 'The current bid shown on items you\'ve bid on now reflects the true Maxanet price — so if a proxy bidder immediately outbids you, you see the real current bid right away, not the stale pre-bid price.' },
      { id: 'bid-auto-poll', icon: '🔄', text: 'Bid prices on items you\'ve bid on refresh automatically every 2 minutes while you\'re on the page, so outbids by other bidders surface without needing to hit Refresh.' },
      { id: 'bid-won-lost', icon: '🏆', text: 'Closed lots you bid on now show a clear Won or Lost badge — no more guessing whether you were the winning bidder on an ended auction.' },
    ],
  },
  {
    date: '2026-06-07',
    title: 'Semantic search on iPhone',
    changes: [
      { id: 'ios-semantic-search-restored', icon: '📱', text: 'Semantic search now works on iPhone and iPad — results rank by meaning, not just keywords, the same as desktop.' },
    ],
  },
  {
    date: '2026-06-07',
    title: 'Smarter semantic search',
    changes: [
      { id: 'nomic-semantic-search', icon: '🔍', text: 'Search is smarter: it now understands what you mean and also matches lots by their photos, so even lots with vague titles like "Lot - 27" turn up for searches like "power tools" — and it loads instantly with nothing to download first.' },
    ],
  },
  {
    date: '2026-06-07',
    title: 'Filter panel overhaul',
    changes: [
      { id: 'filter-panel-overhaul', icon: '⚙', text: 'All filter and view controls are now in a dedicated collapsible sidebar panel — open or close it with the Filters button in the header. Cleaner header with search always visible up top.' },
      { id: 'active-filter-chips', icon: '🏷', text: 'Active filters now show as dismissible chips above the grid so you always see what\'s filtering at a glance — click any chip to clear that filter.' },
      { id: 'mobile-filter-drawer', icon: '📱', text: 'On mobile the filter panel slides up as a full-screen drawer instead of taking space above the items.' },
    ],
  },
  {
    date: '2026-06-06',
    title: 'Comps filter',
    changes: [
      { id: 'comps-filter-rename', icon: '🔎', text: 'The sidebar comp filters are now grouped under "Comps" with clearer labels: eBay, Auctions, and Claude.' },
    ],
  },
  {
    date: '2026-06-06',
    title: 'Image search',
    changes: [
      { id: 'image-search-modal', icon: '📷', text: 'New image search: snap or upload a photo and Claude identifies the item, then surfaces matching active lots, eBay sold comps, FB Marketplace links, and historical Cannon\'s sold prices — all from the 📷 button in the search bar.' },
    ],
  },
  {
    date: '2026-06-06',
    title: 'Facebook Marketplace listing generator',
    changes: [
      { id: 'fb-listing-generator', icon: '📋', text: 'New "List on FB" button in item details: paste your won lot\'s title, description, suggested price, category, and condition straight into a Facebook Marketplace listing — Claude writes a buyer-friendly description and tells you which auction photos to use.' },
    ],
  },
  {
    date: '2026-06-06',
    title: 'Layout & filter tidy-up',
    changes: [
      { id: 'compact-list-view', icon: '📋', text: 'New Compact view: a list of rows with a thumbnail and description, alongside the classic grid — pick whichever scans faster for you.' },
      { id: 'sort-by-max-bid', icon: '↕️', text: 'Sort lots by their recommended max bid to put the highest-value flips on top.' },
      { id: 'has-filters-sidebar', icon: '🔎', text: 'The "Has eBay comp / auction comp / AI product info" toggles moved into a tidy checkbox group in the sidebar.' },
      { id: 'show-segmented', icon: '🗂️', text: 'Favorites and Ignored are now a single Show switch (All / Favorites / Ignored), matching the Auctions control.' },
      { id: 'swipe-in-header', icon: '🃏', text: 'The Swipe button moved up to the top banner so it’s always within reach.' },
      { id: 'trivia-header-button', icon: '⚽', text: 'Daily Arsenal trivia is now a ⚽ button in the header instead of a full-width card, freeing up space for lots.' },
    ],
  },
  {
    date: '2026-06-05',
    title: 'My Bids & bid panel',
    changes: [
      { id: 'mybids-login-error-ux', icon: '🔑', text: "When Cannon's login fails in My Bids, you now get a clear prompt to update your credentials instead of a raw error message." },
    ],
  },
  {
    date: '2026-06-05',
    title: 'Resale insights & live bidding',
    changes: [
      { id: 'place-bid-in-app', icon: '🔨', text: "Bid on Cannon's lots without leaving the site — link your account, enter your max bid, and place it right from the lot's detail panel." },
      { id: 'cannons-sold-history', icon: '📈', text: "Cannon's sold-price history: every lot now shows what similar past lots actually hammered for, and deals are ranked by estimated margin." },
      { id: 'sold-previously-comps', icon: '🔁', text: "“Sold previously” comps surface similar past Cannon's lots and their final prices, right in the detail panel." },
      { id: 'bid-status-cards', icon: '🔨', text: 'Bid status shows up on cards — see at a glance whether you’re winning or have been outbid.' },
      { id: 'resale-members-only', icon: '🔒', text: 'Resale intelligence (eBay comps + sold-price history) is now a members perk — sign in to unlock it.' },
      { id: 'share-button', icon: '🔗', text: 'Share replaces Copy Link, using your device’s native share sheet on mobile.' },
      { id: 'min-profit-filter', icon: '💰', text: 'New minimum-estimated-profit filter to cut straight to the worthwhile flips.' },
      { id: 'sort-by-bidders', icon: '↕️', text: 'Sort by number of bidders, plus a fix for the price/bid range sliders getting stuck.' },
      { id: 'cleaner-categories', icon: '🏷️', text: 'Cleaner categories: thousands of “Other” lots reclassified, and Firearms & Vehicles hidden by default.' },
    ],
  },
  {
    date: '2026-06-04',
    title: 'More sources, smarter triage',
    changes: [
      { id: 'rasmus-source', icon: '🆕', text: 'Rasmus Auctions added as a Richmond-area source — more local lots in one place.' },
      { id: 'swipe-deck', icon: '🃏', text: '“Not interested” list + a Tinder-style swipe deck to triage undecided lots one card at a time.' },
      { id: 'bidder-count', icon: '👥', text: 'Each lot now shows its unique bidder count, and you can filter by a bidders range.' },
      { id: 'archive-filter', icon: '🗂️', text: 'Three-state Active / Archived / All auction filter, plus per-source show/hide/only controls.' },
      { id: 'google-signin', icon: '🔑', text: 'Sign in with Google, and link your Cannon’s account to see a My Bids filter.' },
      { id: 'only-this-category', icon: '👆', text: 'One-click “only this category” filtering from any lot.' },
      { id: 'laptop-grid-fix', icon: '🖥️', text: 'Fixed laptop grid overflow and the email-confirmation redirect.' },
    ],
  },
  {
    date: '2026-06-03',
    title: 'Accounts & cloud favorites',
    changes: [
      { id: 'accounts-cloud-favorites', icon: '⭐', text: 'Create an account (email/password) and your favorites now sync to the cloud across devices.' },
      { id: 'detail-panel-reorg', icon: '📋', text: 'Detail panel reorganized — comps come first, with the margin slider moved into preferences.' },
      { id: 'wider-grid', icon: '📐', text: 'Wider grid on large screens and unified filter headers.' },
    ],
  },
]

// Newest entry's date — handy for display; the unseen dot uses per-change ids
// (see src/utils/whatsNew.js), not this.
export const LATEST_CHANGELOG_DATE = CHANGELOG[0]?.date ?? ''
