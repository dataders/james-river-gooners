import { test, expect } from '@playwright/test'

async function waitForItems(page) {
  await expect(page.locator('.loading')).toBeHidden({ timeout: 20_000 })
  const text = await page.locator('.item-count').textContent()
  const match = text?.match(/^(\d+) items/)
  return match ? parseInt(match[1], 10) : 0
}

function bestDealsButton(page) {
  return page.getByRole('button', { name: 'Best deals', exact: true })
}

// ── Best Deals toggle ─────────────────────────────────────────────────────────

test.describe('Best deals toggle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForItems(page)
  })

  test('Best deals toggle button is present in the header', async ({ page }) => {
    await expect(bestDealsButton(page)).toBeVisible()
  })

  test('Best deals toggle activates on click and adds active class', async ({ page }) => {
    const btn = bestDealsButton(page)
    await expect(btn).not.toHaveClass(/active/)
    await btn.click()
    await expect(btn).toHaveClass(/active/)
  })

  test('Best deals toggle is a two-state toggle', async ({ page }) => {
    const btn = bestDealsButton(page)
    await btn.click()
    await expect(btn).toHaveClass(/active/)
    await btn.click()
    await expect(btn).not.toHaveClass(/active/)
  })

  test('Best deals toggle does not increase item count', async ({ page }) => {
    const totalBefore = await waitForItems(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping best deals test')

    await bestDealsButton(page).click()
    await page.waitForTimeout(300)
    const countAfter = parseInt(
      (await page.locator('.item-count').textContent()).match(/^(\d+) items/)[1]
    )
    expect(countAfter).toBeLessThanOrEqual(totalBefore)
  })

  test('disabling Best deals toggle restores previous item count', async ({ page }) => {
    const totalBefore = await waitForItems(page)
    test.skip(totalBefore === 0, 'No items loaded — skipping best deals test')

    await bestDealsButton(page).click()
    await page.waitForTimeout(300)
    await bestDealsButton(page).click()
    await page.waitForTimeout(300)

    const countAfter = parseInt(
      (await page.locator('.item-count').textContent()).match(/^(\d+) items/)[1]
    )
    expect(countAfter).toBe(totalBefore)
  })
})

// ── Card-level ROI display ────────────────────────────────────────────────────

test.describe('Card ROI display', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForItems(page)
  })

  test('cards with eBay comp data show a Max bid label', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping card ROI test')

    // Wait briefly for async eBay comp data to load and cards to re-render
    await page.waitForTimeout(1500)
    const roiRows = page.locator('.item-roi-row')
    const roiCount = await roiRows.count()
    // At least one item should have eBay comp data in the test fixture
    test.skip(roiCount === 0, 'No items have eBay comp data — skipping card ROI test')

    const firstRow = roiRows.first()
    await expect(firstRow.locator('.item-roi-max')).toBeVisible()
    await expect(firstRow.locator('.item-roi-cost')).toBeVisible()
  })

  test('card Max bid label contains a dollar amount', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping card ROI test')

    await page.waitForTimeout(1500)
    const roiRows = page.locator('.item-roi-row')
    const roiCount = await roiRows.count()
    test.skip(roiCount === 0, 'No items have eBay comp data — skipping card ROI test')

    const maxLabel = await roiRows.first().locator('.item-roi-max').textContent()
    const costLabel = await roiRows.first().locator('.item-roi-cost').textContent()
    // ItemCard renders "Max $165" / "All-in $210" — assert a dollar amount
    // appears after the label prefix rather than at the very start.
    expect(maxLabel).toMatch(/\$\d/)
    expect(costLabel).toMatch(/\$\d/)
  })

  test('All-in cost is always higher than max bid (reflects 1.272x multiplier)', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping card ROI test')

    await page.waitForTimeout(1500)
    const roiRows = page.locator('.item-roi-row')
    const roiCount = await roiRows.count()
    test.skip(roiCount === 0, 'No items have eBay comp data — skipping card ROI test')

    const maxText = await roiRows.first().locator('.item-roi-max').textContent()
    const costText = await roiRows.first().locator('.item-roi-cost').textContent()
    const maxVal = parseInt(maxText.replace(/[^0-9]/g, ''))
    const costVal = parseInt(costText.replace(/[^0-9]/g, ''))
    expect(costVal).toBeGreaterThan(maxVal)
  })
})

// ── ROI Calculator in item detail modal ───────────────────────────────────────

test.describe('ROI calculator in detail modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForItems(page)
  })

  test('opening an item with eBay comps shows the ROI calculator above comps section', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping ROI modal test')

    await page.waitForTimeout(1500)
    // Find a card that has ROI data loaded
    const cards = page.locator('.item-card:has(.item-roi-row)')
    const cardCount = await cards.count()
    test.skip(cardCount === 0, 'No items have comp data loaded — skipping ROI modal test')

    await cards.first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()
    await expect(page.locator('.roi-calc')).toBeVisible()
  })

  test('eBay comps section appears before the ROI calculator in the DOM', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping ROI modal test')

    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'No items have comp data loaded — skipping ROI modal test')

    await cards.first().click()
    await expect(page.locator('.detail-overlay')).toBeVisible()

    const roiCalc = page.locator('.roi-calc')
    const ebayComps = page.locator('.ebay-comps')
    await expect(roiCalc).toBeVisible()
    await expect(ebayComps).toBeVisible()

    // Comps lead, calculator is secondary (#88)
    const roiBox = await roiCalc.boundingBox()
    const compsBox = await ebayComps.boundingBox()
    expect(compsBox.y).toBeLessThan(roiBox.y)
  })

  test('ROI calculator shows comp median, margin readout, max bid, and total cost (no inline slider)', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping ROI modal test')

    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'No items have comp data loaded — skipping ROI modal test')

    await cards.first().click()
    const panel = page.locator('.detail-panel')
    await expect(panel.locator('.roi-calc')).toBeVisible()
    await expect(panel.locator('.roi-comps-line').first()).toBeVisible()
    await expect(panel.locator('.roi-result-value').first()).toBeVisible()
    await expect(panel.locator('.roi-footnote')).toContainText("buyer's premium")
    // The margin slider moved to the sidebar preferences (#89) — it is no longer in the panel.
    await expect(panel.locator('.roi-margin-slider')).toHaveCount(0)
  })

  test('margin slider lives in the sidebar, and changing it updates the max bid', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping ROI modal test')

    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'No items have comp data loaded — skipping ROI modal test')

    // Read the max bid at the default 30% margin, then close the panel.
    await cards.first().click()
    await expect(page.locator('.roi-calc')).toBeVisible()
    const maxBidBefore = await page.locator('.roi-result-value').first().textContent()
    await page.keyboard.press('Escape')
    await expect(page.locator('.detail-overlay')).toBeHidden()

    // The slider is the global preference in the sidebar, not the detail panel.
    const slider = page.locator('.margin-pref .roi-margin-slider')
    await expect(slider).toBeVisible()
    // Drop margin to 0% (break-even) — max bid should rise. Use the native value
    // setter so React's tracked value updates and onChange fires (see helpers.js).
    await slider.evaluate(el => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, '0')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Reopen the same item; the calculator now reflects the 0% margin.
    await cards.first().click()
    await expect(page.locator('.roi-calc')).toBeVisible()
    const maxBidAfter = await page.locator('.roi-result-value').first().textContent()

    const before = parseInt(maxBidBefore.replace(/[^0-9]/g, ''))
    const after = parseInt(maxBidAfter.replace(/[^0-9]/g, ''))
    expect(after).toBeGreaterThan(before)
  })

  test('ROI calculator footnote mentions 20% buyer premium and 6% tax', async ({ page }) => {
    const count = await waitForItems(page)
    test.skip(count === 0, 'No items loaded — skipping ROI modal test')

    await page.waitForTimeout(1500)
    const cards = page.locator('.item-card:has(.item-roi-row)')
    test.skip(await cards.count() === 0, 'No items have comp data loaded — skipping ROI modal test')

    await cards.first().click()
    const footnote = page.locator('.roi-footnote')
    await expect(footnote).toContainText('20%')
    await expect(footnote).toContainText('6%')
  })
})
