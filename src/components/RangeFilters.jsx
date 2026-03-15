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

// Log scale helpers: map between linear slider position [0, steps] and real value [min, max]
// Uses log(1+x) to handle min=0 gracefully
function toLog(value, min, max) {
  if (max <= min) return 0
  const minLog = Math.log1p(min)
  const maxLog = Math.log1p(max)
  return (Math.log1p(value) - minLog) / (maxLog - minLog)
}

function fromLog(ratio, min, max) {
  const minLog = Math.log1p(min)
  const maxLog = Math.log1p(max)
  return Math.expm1(minLog + ratio * (maxLog - minLog))
}

const SLIDER_STEPS = 200

const NUM_BINS = 40

function buildHistogram(values, min, max, logScale) {
  if (max <= min || values.length === 0) return new Array(NUM_BINS).fill(0)
  const bins = new Array(NUM_BINS).fill(0)
  for (const v of values) {
    const ratio = logScale ? toLog(v, min, max) : (v - min) / (max - min)
    const idx = Math.min(NUM_BINS - 1, Math.floor(ratio * NUM_BINS))
    bins[idx]++
  }
  return bins
}

function Histogram({ bins, valueLoPct, valueHiPct }) {
  const peak = Math.max(...bins, 1)

  return (
    <svg className="histogram" viewBox={`0 0 ${NUM_BINS} 20`} preserveAspectRatio="none">
      {bins.map((count, i) => {
        const barLo = i / NUM_BINS
        const barHi = (i + 1) / NUM_BINS
        const inRange = barHi >= valueLoPct && barLo <= valueHiPct
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

function DualSlider({ label, min, max, valueLo, valueHi, formatLo, formatHi, formatBoundLo, formatBoundHi, onLoChange, onHiChange, histogram, logScale }) {
  const loAtMin = valueLo <= min
  const hiAtMax = valueHi >= max
  const summary = loAtMin && hiAtMax
    ? 'Any'
    : loAtMin
      ? `≤ ${formatHi(valueHi)}`
      : hiAtMax
        ? `≥ ${formatLo(valueLo)}`
        : `${formatLo(valueLo)} – ${formatHi(valueHi)}`

  // Convert real values to slider positions
  const sliderLo = logScale
    ? Math.round(toLog(valueLo, min, max) * SLIDER_STEPS)
    : Math.round(((valueLo - min) / (max - min)) * SLIDER_STEPS)
  const sliderHi = logScale
    ? Math.round(toLog(valueHi, min, max) * SLIDER_STEPS)
    : Math.round(((valueHi - min) / (max - min)) * SLIDER_STEPS)

  const handleLo = (e) => {
    const pos = Number(e.target.value)
    const ratio = pos / SLIDER_STEPS
    const real = logScale ? fromLog(ratio, min, max) : min + ratio * (max - min)
    const snapped = Math.round(real)
    onLoChange(Math.min(snapped, valueHi))
  }

  const handleHi = (e) => {
    const pos = Number(e.target.value)
    const ratio = pos / SLIDER_STEPS
    const real = logScale ? fromLog(ratio, min, max) : min + ratio * (max - min)
    const snapped = Math.round(real)
    onHiChange(Math.max(snapped, valueLo))
  }

  // Percentage positions for histogram highlighting
  const valueLoPct = logScale ? toLog(valueLo, min, max) : (valueLo - min) / (max - min || 1)
  const valueHiPct = logScale ? toLog(valueHi, min, max) : (valueHi - min) / (max - min || 1)

  return (
    <div className="range-filter">
      <label className="range-label">
        {label}
        <span className="range-value">{summary}</span>
      </label>
      <div className="dual-slider">
        {histogram && (
          <Histogram bins={histogram} valueLoPct={valueLoPct} valueHiPct={valueHiPct} />
        )}
        <input
          type="range"
          className="range-slider range-slider-lo"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderLo}
          onChange={handleLo}
        />
        <input
          type="range"
          className="range-slider range-slider-hi"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={sliderHi}
          onChange={handleHi}
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
      priceHist: buildHistogram(prices, 0, pMax, true),
      bidsHist: buildHistogram(bidCounts, 0, bMax, true),
      hoursHist: buildHistogram(hours, 0, hMax, false),
    }
  }, [items])

  if (!priceMax && !hoursMax && !bidsMax) return null

  const formatBids = (v) => `${Math.round(v)}`

  return (
    <div className="range-filters">
      <DualSlider
        label="Price"
        min={0}
        max={priceMax}
        valueLo={minPrice ?? 0}
        valueHi={maxPrice ?? priceMax}
        formatLo={formatPrice}
        formatHi={formatPrice}
        formatBoundLo="$0"
        formatBoundHi={formatPrice(priceMax)}
        onLoChange={onMinPriceChange}
        onHiChange={onMaxPriceChange}
        histogram={priceHist}
        logScale
      />
      <DualSlider
        label="Bids"
        min={0}
        max={bidsMax}
        valueLo={minBids ?? 0}
        valueHi={maxBids ?? bidsMax}
        formatLo={formatBids}
        formatHi={formatBids}
        formatBoundLo="0"
        formatBoundHi={String(bidsMax)}
        onLoChange={onMinBidsChange}
        onHiChange={onMaxBidsChange}
        histogram={bidsHist}
        logScale
      />
      <DualSlider
        label="Ends within"
        min={0}
        max={hoursMax}
        valueLo={minHours ?? 0}
        valueHi={maxHours ?? hoursMax}
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
