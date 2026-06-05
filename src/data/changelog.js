// Single source of truth for the in-app "What's New" feed and CHANGELOG.md.
// Newest release first. `date` (YYYY-MM-DD) drives the unseen-updates badge in
// useWhatsNew — bump/add an entry here and the badge lights up for everyone who
// hasn't opened the panel since that date. Keep wording user-facing: describe
// what changed for someone browsing auctions, not the implementation.

export const CHANGELOG = [
  {
    date: '2026-06-05',
    title: 'Resale insights & live bidding',
    changes: [
      { icon: '📈', text: "Cannon's sold-price history: every lot now shows what similar past lots actually hammered for, and deals are ranked by estimated margin." },
      { icon: '🔁', text: "“Sold previously” comps surface similar past Cannon's lots and their final prices, right in the detail panel." },
      { icon: '🔨', text: 'Bid status shows up on cards — see at a glance whether you’re winning or have been outbid.' },
      { icon: '🔒', text: 'Resale intelligence (eBay comps + sold-price history) is now a members perk — sign in to unlock it.' },
      { icon: '🔗', text: 'Share replaces Copy Link, using your device’s native share sheet on mobile.' },
      { icon: '💰', text: 'New minimum-estimated-profit filter to cut straight to the worthwhile flips.' },
      { icon: '↕️', text: 'Sort by number of bidders, plus a fix for the price/bid range sliders getting stuck.' },
      { icon: '🏷️', text: 'Cleaner categories: thousands of “Other” lots reclassified, and Firearms & Vehicles hidden by default.' },
    ],
  },
  {
    date: '2026-06-04',
    title: 'More sources, smarter triage',
    changes: [
      { icon: '🆕', text: 'Rasmus Auctions added as a Richmond-area source — more local lots in one place.' },
      { icon: '🃏', text: '“Not interested” list + a Tinder-style swipe deck to triage undecided lots one card at a time.' },
      { icon: '👥', text: 'Each lot now shows its unique bidder count, and you can filter by a bidders range.' },
      { icon: '🗂️', text: 'Three-state Active / Archived / All auction filter, plus per-source show/hide/only controls.' },
      { icon: '🔑', text: 'Sign in with Google, and link your Cannon’s account to see a My Bids filter.' },
      { icon: '👆', text: 'One-click “only this category” filtering from any lot.' },
      { icon: '🖥️', text: 'Fixed laptop grid overflow and the email-confirmation redirect.' },
    ],
  },
  {
    date: '2026-06-03',
    title: 'Accounts & cloud favorites',
    changes: [
      { icon: '⭐', text: 'Create an account (email/password) and your favorites now sync to the cloud across devices.' },
      { icon: '📋', text: 'Detail panel reorganized — comps come first, with the margin slider moved into preferences.' },
      { icon: '📐', text: 'Wider grid on large screens and unified filter headers.' },
    ],
  },
]

// Drives the "unseen updates" dot. Newest entry's date.
export const LATEST_CHANGELOG_DATE = CHANGELOG[0]?.date ?? ''
