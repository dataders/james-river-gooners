// @ts-nocheck
import { calcMaxBid, COST_MULTIPLIER, extractCompPrices, calcMedian, DEFAULT_MARGIN } from '../utils/roiCalc'
import { normalizeEbaySoldMatches } from '../utils/ebayComps'

const fmt = v => `$${Math.round(v).toLocaleString()}`

// Margin is a fixed default (the per-item slider and the sidebar preference were
// removed), so this panel stays focused on the all-in cost (#88/#89).
export function RoiCalculator({ soldComps, margin = DEFAULT_MARGIN * 100 }) {
  const normalized = normalizeEbaySoldMatches(soldComps)
  const prices = extractCompPrices(normalized)
  const median = calcMedian(prices)

  if (median === null) return null

  const maxBid = calcMaxBid(median, margin / 100)
  const totalCost = maxBid * COST_MULTIPLIER

  return (
    <section className="roi-calc">
      <div className="roi-calc-header">
        <h3>Max bid calculator</h3>
      </div>

      <div className="roi-comps-line">
        <span className="roi-label">eBay comp median</span>
        <span className="roi-comp-value">
          {fmt(median)}
          <span className="roi-comp-count">({prices.length} comp{prices.length !== 1 ? 's' : ''})</span>
        </span>
      </div>

      <div className="roi-comps-line">
        <span className="roi-label">Resale margin</span>
        <span className="roi-comp-value">{margin}%</span>
      </div>

      <div className="roi-results">
        <div className="roi-result-block roi-result-block--primary">
          <span className="roi-result-label">Max bid</span>
          <span className="roi-result-value">{fmt(maxBid)}</span>
        </div>
        <div className="roi-result-block">
          <span className="roi-result-label">Total cost</span>
          <span className="roi-result-value roi-result-cost">{fmt(totalCost)}</span>
        </div>
      </div>

      <div className="roi-footnote">20% buyer's premium + 6% VA sales tax · {margin}% resale margin</div>
    </section>
  )
}