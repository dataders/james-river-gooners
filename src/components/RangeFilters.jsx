import { useMemo } from 'react'

function hoursUntil(endDate) {
  if (!endDate) return Infinity
  const end = new Date(endDate.replace(/-/g, '/'))
  return Math.max(0, (end - new Date()) / 3600000)
}

function formatHours(h) {
  if (h >= 24 * 7) return `${Math.round(h / 24 / 7)}w`
  if (h >= 24) return `${Math.round(h / 24)}d`
  return `${Math.round(h)}h`
}

function formatPrice(v) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  return `$${Math.round(v)}`
}

const NUM_BINS = 40

function buildHistogram(values, min, max) {
  if (max <= min || values.length === 0) return new Array(NUM_BINS).fill(0)
  const bins = new Array(NUM_BINS).fill(0)
  const range = max - min
  for (const v of values) {
    const idx = Math.min(NUM_BINS - 1, Math.floor(((v - min) / range) * NUM_BINS))
    bins[idx]++
  }
  return bins
}

function Histogram({ bins, min, max, valueLo, valueHi }) {
  const peak = Math.max(...bins, 1)
  const range = max - min || 1

  return (
    <svg className="histogram" viewBox={`0 0 ${NUM_BINS} 20`} preserveAspectRatio="none">
      {bins.map((count, i) => {
        const barMin = min + (i / NUM_BINS) * range
        const barMax = min + ((i + 1) / NUM_BINS) * range
        const inRange = barMax >= valueLo && barMin <= valueHi
        const h = (count / peak) * 20
        return (
          <rect
            key={i}
            x={i}
            y={20 - h}
            width={0.85}
            height={h}
            className={inRange ? 'hist-bar-active' : 'hist-bar'}
          />
        )
      })}
    </svg>
  )
}

function DualSlider({ label, min, max, valueLo, valueHi, step, formatLo, formatHi, formatBoundLo, formatBoundHi, onLoChange, onHiChange, histogram }) {
  const loAtMin = valueLo <= min
  const hiAtMax = valueHi >= max
  const summary = loAtMin && hiAtMax
    ? 'Any'
    : loAtMin
      ? `≤ ${formatHi(valueHi)}`
      : hiAtMax
        ? `≥ ${formatLo(valueLo)}`
        : `${formatLo(valueLo)} – ${formatHi(valueHi)}`

  return (
    <div className="range-filter">
      <label className="range-label">
        {label}
        <span className="range-value">{summary}</span>
      </label>
      <div className="dual-slider">
        {histogram && (
          <Histogram bins={histogram} min={min} max={max} valueLo={valueLo} valueHi={valueHi} />
        )}
        <input
          type="range"
          className="range-slider range-slider-lo"
          min={min}
          max={max}
          step={step}
          value={valueLo}
          onChange={e => {
            const v = Number(e.target.value)
            onLoChange(Math.min(v, valueHi))
          }}
        />
        <input
          type="range"
          className="range-slider range-slider-hi"
          min={min}
          max={max}
          step={step}
          value={valueHi}
          onChange={e => {
            const v = Number(e.target.value)
            onHiChange(Math.max(v, valueLo))
          }}
        />
      </div>
      <div className="range-bounds">
        <span>{formatBoundLo}</span>
        <span>{formatBoundHi}</span>
      </div>
    </div>
  )
}

export function RangeFilters({
  items,
  minPrice, maxPrice, onMinPriceChange, onMaxPriceChange,
  minHours, maxHours, onMinHoursChange, onMaxHoursChange,
  minBids, maxBids, onMinBidsChange, onMaxBidsChange,
}) {
  const { priceMax, hoursMax, bidsMax, priceHist, bidsHist, hoursHist } = useMemo(() => {
    let pMax = 0
    let hMax = 0
    let bMax = 0
    const prices = []
    const bidCounts = []
    const hours = []
    for (const item of items) {
      prices.push(item.currentBid)
      bidCounts.push(item.totalBids)
      if (item.currentBid > pMax) pMax = item.currentBid
      if (item.totalBids > bMax) bMax = item.totalBids
      const h = hoursUntil(item.endDate)
      if (h !== Infinity) {
        hours.push(h)
        if (h > hMax) hMax = h
      }
    }
    pMax = Math.ceil(pMax)
    hMax = Math.ceil(hMax)
    return {
      priceMax: pMax,
      hoursMax: hMax,
      bidsMax: bMax,
      priceHist: buildHistogram(prices, 0, pMax),
      bidsHist: buildHistogram(bidCounts, 0, bMax),
      hoursHist: buildHistogram(hours, 0, hMax),
    }
  }, [items])

  if (!priceMax && !hoursMax && !bidsMax) return null

  const step = (max) => Math.max(1, Math.floor(max / 100))
  const formatBids = (v) => `${Math.round(v)}`

  return (
    <div className="range-filters">
      <DualSlider
        label="Price"
        min={0}
        max={priceMax}
        valueLo={minPrice ?? 0}
        valueHi={maxPrice ?? priceMax}
        step={step(priceMax)}
        formatLo={formatPrice}
        formatHi={formatPrice}
        formatBoundLo="$0"
        formatBoundHi={formatPrice(priceMax)}
        onLoChange={onMinPriceChange}
        onHiChange={onMaxPriceChange}
        histogram={priceHist}
      />
      <DualSlider
        label="Bids"
        min={0}
        max={bidsMax}
        valueLo={minBids ?? 0}
        valueHi={maxBids ?? bidsMax}
        step={Math.max(1, Math.floor(bidsMax / 50))}
        formatLo={formatBids}
        formatHi={formatBids}
        formatBoundLo="0"
        formatBoundHi={String(bidsMax)}
        onLoChange={onMinBidsChange}
        onHiChange={onMaxBidsChange}
        histogram={bidsHist}
      />
      <DualSlider
        label="Ends within"
        min={0}
        max={hoursMax}
        valueLo={minHours ?? 0}
        valueHi={maxHours ?? hoursMax}
        step={step(hoursMax)}
        formatLo={formatHours}
        formatHi={formatHours}
        formatBoundLo="Now"
        formatBoundHi={formatHours(hoursMax)}
        onLoChange={onMinHoursChange}
        onHiChange={onMaxHoursChange}
        histogram={hoursHist}
      />
    </div>
  )
}

export { hoursUntil }
