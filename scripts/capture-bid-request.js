#!/usr/bin/env node
// One-shot Playwright script to capture the Maxanet bid POST request.
//
// Run against a live auction lot (cheap, ending soon) while watching DevTools
// would be painful — this does it headlessly instead.
//
// Usage:
//   CANNON_EMAIL=you@example.com CANNON_PASS=yourpass \
//   CANNON_ITEM_URL="https://bid.cannonsauctions.com/Public/Auction/AuctionItemDetail?..." \
//   node scripts/capture-bid-request.js
//
// Output: the POST endpoint URL, request headers, request body, and response
// status + body for every POST fired after clicking "Bid Now". Paste the
// relevant request into the cannon-proxy Edge Function as the place_bid action.
//
// NOTE: This WILL place a real bid if the click succeeds. Use a lot with a
// $1 increment that you're OK winning, or cancel the invoice afterwards.

import { chromium } from '@playwright/test'

const CANNON_EMAIL    = process.env.CANNON_EMAIL
const CANNON_PASS     = process.env.CANNON_PASS
const CANNON_ITEM_URL = process.env.CANNON_ITEM_URL

if (!CANNON_EMAIL || !CANNON_PASS || !CANNON_ITEM_URL) {
  console.error('Required env vars: CANNON_EMAIL, CANNON_PASS, CANNON_ITEM_URL')
  process.exit(1)
}

const BASE = 'https://bid.cannonsauctions.com'

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
const page    = await context.newPage()

// ── Capture every POST ────────────────────────────────────────────────────────

page.on('request', req => {
  if (req.method() !== 'POST') return
  console.log('\n━━ POST REQUEST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('URL    :', req.url())
  console.log('Headers:', JSON.stringify(req.headers(), null, 2))
  const body = req.postData()
  // Redact password from logged output
  const redacted = body?.replace(/(?<=Password=)[^&]*/g, '***') ?? '(empty)'
  console.log('Body   :', redacted)
})

page.on('response', async resp => {
  if (resp.request().method() !== 'POST') return
  let body
  try { body = await resp.text() } catch { body = '(unreadable)' }
  console.log('\n━━ POST RESPONSE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('URL    :', resp.url())
  console.log('Status :', resp.status())
  console.log('Body   :', body.slice(0, 2000))
})

// ── Log in ────────────────────────────────────────────────────────────────────

console.log('\nNavigating to login page…')
await page.goto(`${BASE}/Public/Account/Login`, { waitUntil: 'networkidle' })

// Dump all inputs and buttons so we can diagnose selector mismatches
const loginInputs = await page.locator('input').all()
console.log('Inputs found on login page:')
for (const el of loginInputs) {
  const name = await el.getAttribute('name').catch(() => '')
  const type = await el.getAttribute('type').catch(() => '')
  const id   = await el.getAttribute('id').catch(() => '')
  console.log(`  name="${name}" type="${type}" id="${id}"`)
}
const loginButtons = await page.locator('button, a[href*="login" i], [role="button"]').all()
console.log('Buttons/links found on login page:')
for (const el of loginButtons) {
  const tag  = await el.evaluate(n => n.tagName).catch(() => '')
  const type = await el.getAttribute('type').catch(() => '')
  const id   = await el.getAttribute('id').catch(() => '')
  const cls  = await el.getAttribute('class').catch(() => '')
  const text = await el.textContent().catch(() => '')
  console.log(`  <${tag.toLowerCase()}> type="${type}" id="${id}" class="${cls}" text="${text?.trim()}"`)
}

// Cannon's login form field is "Username" (not Email or BidderNumber)
const emailField = page.locator('input[name="Username"]').first()
await emailField.fill(CANNON_EMAIL)
await page.locator('input[type="password"]').first().fill(CANNON_PASS)

console.log('Submitting login…')
await page.locator('#SubmitLogin').click()
// AJAX login — wait for network to settle, then check URL
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
console.log('Post-submit URL:', page.url())

if (page.url().includes('/Login')) {
  // Dump visible text to surface the error message
  const body = await page.locator('body').innerText().catch(() => '')
  console.error('Login failed — still on login page. Page text:\n', body.slice(0, 1000))
  await browser.close()
  process.exit(1)
}
console.log('Logged in. Current URL:', page.url())

// ── Navigate to item ──────────────────────────────────────────────────────────

console.log('\nNavigating to item…')
await page.goto(CANNON_ITEM_URL, { waitUntil: 'domcontentloaded' })

// Log all visible bid-related inputs for context
const inputs = await page.locator('input').all()
console.log('\nAll inputs on page:')
for (const input of inputs) {
  const name  = await input.getAttribute('name').catch(() => '')
  const id    = await input.getAttribute('id').catch(() => '')
  const type  = await input.getAttribute('type').catch(() => '')
  const value = await input.getAttribute('value').catch(() => '')
  if (name || id) console.log(`  name="${name}" id="${id}" type="${type}" value="${value}"`)
}

// ── Find bid input and fill minimum bid ───────────────────────────────────────

// Try common selectors for the bid amount field
const bidInputSelectors = [
  'input[name*="Bid"]:not([type="hidden"])',
  'input[id*="Bid"]:not([type="hidden"])',
  'input[name*="Amount"]:not([type="hidden"])',
  'input[placeholder*="bid" i]',
  'input[placeholder*="amount" i]',
]

let bidInput = null
for (const sel of bidInputSelectors) {
  const el = page.locator(sel).first()
  if (await el.count() > 0) { bidInput = el; break }
}

if (!bidInput) {
  console.error('Could not find bid amount input — update bidInputSelectors above')
  await browser.close()
  process.exit(1)
}

const currentVal = await bidInput.inputValue()
console.log(`\nBid input current value: "${currentVal}"`)
// Leave the pre-filled minimum bid as-is; just make sure it's focused
await bidInput.click()

// ── Click Bid Now ─────────────────────────────────────────────────────────────

const bidButtonSelectors = [
  'button:has-text("Bid Now")',
  'input[value="Bid Now"]',
  'button:has-text("Place Bid")',
  'input[value="Place Bid"]',
]

let bidButton = null
for (const sel of bidButtonSelectors) {
  const el = page.locator(sel).first()
  if (await el.count() > 0) { bidButton = el; break }
}

if (!bidButton) {
  console.error('Could not find "Bid Now" button — update bidButtonSelectors above')
  await browser.close()
  process.exit(1)
}

console.log('\nClicking "Bid Now" — watch for POST requests above…')
await bidButton.click()
await page.waitForTimeout(3000) // let the AJAX response land

await browser.close()
console.log('\nDone.')
