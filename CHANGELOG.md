# Changelog

User-facing changes to James River Gooners. This mirrors the in-app **What's
New** panel (the ✨ button in the header); both are generated from the same
list in `src/data/changelog.js`, so update that file when you add an entry.

## 2026-06-19 — Swipe deck deals your For You picks first

- 🃏 **Swipe in For You order** — the Swipe deck now deals cards in your For You order — the lots it thinks you'll love come up first, instead of whatever order you happened to be browsing in.

## 2026-06-19 — For You learns from what you skip

- 🎯 **Not interested shapes For You** — the “For You” sort now pays attention to your Not interested list, not just your favorites. Lots that look like ones you've dismissed get pushed down the ranking, so the more you swipe, the sharper your recommendations get.

## 2026-06-19 — Better link previews when sharing

- 🔗 **Rich link previews** — sharing a lot via the Share button now generates a rich preview in Slack, Discord, iMessage, and other apps — showing the lot photo, title, category, and current bid instead of the generic site icon.

## 2026-06-19 — Browse listing photos without opening the lot

- 👆 **Swipe through photos on mobile** — on mobile you can now swipe left or right on any listing photo to flip through all its images without tapping to open the lot.
- ◀▶ **Arrow buttons on desktop** — on desktop, hover over a listing photo and semi-transparent arrows appear on the sides so you can quickly scan through multiple images from the grid.

## 2026-06-16 — A tidier toolbar on phones

- ☰ **Toolbar tucked into a menu (phones)** — on phones, the toolbar buttons (photo search, swipe, help, what's new, trivia, dark mode) and your account now live in a tidy menu — tap the ☰ in the top-left to open it. Your bid alerts show right on the menu button, so you still see at a glance when you've been outbid.

## 2026-06-14 — Lot details right on the grid

- 🏷️ **Lot details on the cards** — quantity, condition warnings (like "untested" or "missing parts"), and key specs (like "20V" or "brushless") now show right on the lot cards as you browse, so you can size up a lot at a glance without opening it.

## 2026-06-13 — Richer lot details & sharper eBay searches

- 🏷️ **More lot detail at a glance** — identified lots now show a "Mixed lot" tag and quantity when a lot is a box of varied items, plus condition warnings (untested, missing parts) and key specs (like "20V" or "brushless") right on the detail.
- 🔎 **Every item in a mixed lot** — when a lot contains several different name-brand items, each one is now listed separately with its own eBay sold-price search, so you can value the whole box, not just the headline item.
- 🎯 **Smarter eBay search link** — the "Search eBay" link now uses the lot's identified brand, model and type instead of its raw description, so it lands on the right sold listings far more often.

## 2026-06-13 — More lots get identified

- 🪑 **More lots get identified** — antique furniture, paintings, and decorative pieces now get identified too — a mid-century walnut table or a signed watercolor now shows a product name and resale comps, not just the lots with an obvious brand.

## 2026-06-13 — Your filters follow your account

- 🔒 **Filters sync to your account** — when you're signed in, your filters (hidden categories, price and bid ranges, sort and layout) now save to your account and follow you across devices. Hide Coins, Silver and Jewelry once and they stay hidden everywhere you log in.

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
- 🚗 **Vehicles filter fixed** — whole cars, trucks and motorcycles now land in the Vehicles category, so hiding Vehicles actually hides them — previously they slipped into "Other" and kept showing up.
- 🗂️ **"Other" cleanup** — hundreds of lots that were dumped in "Other" — sports cards, coins, rugs, die-cast toys, cast-iron & enamelware, stamps, vintage advertising — now sort into their proper categories, so browsing and filtering by category is much more accurate.
- 🐾 **Pet Adoption category** — added a dedicated Pet Adoption category for the live animals listed for adoption, so they're easy to find — or hide.
- 🧹 **Closed lots hidden by default** — lots that have already closed are now hidden from the main grid by default — even when the rest of their auction is still live and staggering lots shut over several days. Flip on "All auctions" to bring ended lots (and their final prices) back into view.

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
