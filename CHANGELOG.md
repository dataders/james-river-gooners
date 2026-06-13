# Changelog

User-facing changes to James River Gooners. This mirrors the in-app **What's
New** panel (the ✨ button in the header); both are generated from the same
list in `src/data/changelog.js`, so update that file when you add an entry.

## 2026-06-13 — Easier price & bidding filters

- 🎚 **Easier sliders** — the Price, Bids and Bidders sliders are much easier to grab and drag now — especially on a phone, where the handles were fiddly to hit before.
- ⏰ **Ends within presets** — the "Ends within" filter is now simple quick buttons — 1 hour, 1 day, 1 week, 1 month, or All — instead of a fiddly time slider.
- 🎯 **Correct slider ranges** — the price and bidding sliders now show their correct range right away instead of starting too small and shifting as more lots load in.

## 2026-06-13 — Snappier browsing

- ⚡ **Faster first load** — the site now loads noticeably faster the first time you open it — the heavy AI-search model only downloads once you actually use search, instead of on every visit.
- 🧈 **Smoother scrolling** — scrolling through thousands of lots is smoother now, and typing in search or dragging the filter sliders no longer makes the grid stutter.
- ⬅️ **Back closes an item** — pressing your browser or phone Back button now closes an open item instead of leaving the site.
- 🔢 **Filter counts match the view** — the Favorites and Ignored counts in the filter menu now match what you actually see — they reflect the active/archived auctions currently loaded, instead of always showing your all-time total.
- 🕐 **Ended lots show when they closed** — lots that have closed now show when they ended (e.g. "Ended Jun 11, 7:56 PM") instead of just "Ended" — handy when a lot finishes early while the rest of its auction is still running.

## 2026-06-09 — Faster loading

- ⚡ **Faster loading** — the auction grid now appears in a couple of seconds and fills in the rest of the lots as they load, instead of sitting on a "Fetching auction data" spinner until everything is ready.

## 2026-06-08 — Bid status notifications

- 🔴 **Bid alert badge** — a red badge now appears on the account icon when you've been outbid on any active item — tap your profile to see what's changed.
- 📋 **Outbid highlight** — outbid items are now highlighted with a red left border in My Bids so they jump out at a glance.
- 🕐 **Checked time** — each item in My Bids now shows when its status was last checked, so you know exactly how fresh the winning/outbid information is.
- ⚡ **Faster bid refresh** — bid statuses now refresh every minute (was every 2 minutes) while the page is open.

## 2026-06-07 — Smarter semantic search

- 🔍 **Smarter search** — search now understands what you mean and also matches lots by their photos, so even lots with vague titles like "Lot - 27" turn up for searches like "power tools" — and it loads instantly with nothing to download first.

## 2026-06-07 — Filter panel overhaul

- ⚙ **Filter panel** — all filter and view controls are now in a dedicated collapsible sidebar panel; open or close it with the Filters button in the header, with a cleaner header showing search always up top.
- 🏷 **Active filter chips** — active filters now show as dismissible chips above the grid so you always see what's filtering at a glance; click any chip to clear that filter.
- 📱 **Mobile filter drawer** — on mobile the filter panel slides up as a full-screen drawer instead of taking space above the items.

## 2026-06-06 — Comps filter

- 🔎 **Comps filter** — the sidebar comp filters are now grouped under "Comps" with clearer labels: eBay, Auctions, and Claude.

## 2026-06-06 — Image search

- 📷 **Image search** — snap or upload a photo and Claude identifies the item, then surfaces matching active lots, eBay sold comps, FB Marketplace links, and historical Cannon's sold prices — all from the 📷 button in the search bar.

## 2026-06-06 — Layout & filter tidy-up

- 📋 **Compact view** — a list of rows with a thumbnail and description, alongside the classic grid; pick whichever scans faster for you.
- ↕️ **Sort by max bid** — order lots by their recommended max bid to put the highest-value flips on top.
- 🔎 **"Has" filters in the sidebar** — the eBay comp / auction comp / AI product info toggles moved into a tidy checkbox group.
- 🗂️ **Show switch** — Favorites and Ignored are now a single segmented control (All / Favorites / Ignored), matching the Auctions control.
- 🃏 **Swipe in the header** — the Swipe button moved up to the top banner so it's always within reach.
- ⚽ **Trivia button** — daily Arsenal trivia is now a ⚽ button in the header instead of a full-width card, freeing up space for lots.

## 2026-06-05 — My Bids & bid panel

- 🔑 **Cleaner login error in My Bids** — when Cannon's login fails, you now get a clear prompt to update your credentials instead of a raw error message.

## 2026-06-05 — Resale insights & live bidding

- 🔨 **Bid in-app** — bid on Cannon's lots without leaving the site: link your account, enter your max bid, and place it right from the lot's detail panel.
- 📈 **Cannon's sold-price history** — every lot now shows what similar past lots actually hammered for, and deals are ranked by estimated margin.
- 🔁 **"Sold previously" comps** — similar past Cannon's lots and their final prices surface right in the detail panel.
- 🔨 **Bid status on cards** — see at a glance whether you're winning or have been outbid.
- 🔒 **Members-only resale intelligence** — eBay comps + sold-price history now require a sign-in to unlock.
- 🔗 **Share button** — replaces Copy Link, using your device's native share sheet on mobile.
- 💰 **Minimum-estimated-profit filter** — cut straight to the worthwhile flips.
- ↕️ **Sort by bidders** — plus a fix for the price/bid range sliders getting stuck.
- 🏷️ **Cleaner categories** — thousands of "Other" lots reclassified, and Firearms & Vehicles hidden by default.

## 2026-06-04 — More sources, smarter triage

- 🆕 **Rasmus Auctions** added as a Richmond-area source — more local lots in one place.
- 🃏 **"Not interested" list + swipe deck** — a Tinder-style deck to triage undecided lots one card at a time.
- 👥 **Unique bidder count** per lot, plus a bidders-range filter.
- 🗂️ **Active / Archived / All** auction filter, plus per-source show/hide/only controls.
- 🔑 **Google sign-in**, and link your Cannon's account to see a My Bids filter.
- 👆 **One-click "only this category"** filtering from any lot.
- 🖥️ Fixed laptop grid overflow and the email-confirmation redirect.

## 2026-06-03 — Accounts & cloud favorites

- ⭐ **Accounts + cloud favorites** — create an account (email/password) and your favorites sync across devices.
- 📋 **Detail panel reorganized** — comps come first, with the margin slider moved into preferences.
- 📐 **Wider grid** on large screens and unified filter headers.
