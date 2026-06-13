import { useMemo, useRef, useState, useLayoutEffect } from 'react'
import * as Slider from '@radix-ui/react-slider'

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

// Thumb radius must match half the CSS width of .range-slider-thumb (20px → 10px).
// Radix insets each thumb so it stays within the track bounds — the thumb *center*
// travels from THUMB_RADIUS to (width − THUMB_RADIUS), exactly like a native range
// input. We compute bar pixel positions with the same inset so bins stay aligned
// with the slider track across browsers and screen sizes.
const THUMB_RADIUS = 10

function Histogram({ bins, valueLoPct, valueHiPct, containerWidth }) {
  if (!containerWidth) return null
  const trackWidth = containerWidth - 2 * THUMB_RADIUS
  const sqrtPeak = Math.sqrt(Math.max(...bins, 1))

  return (
    <svg
      className="histogram"
      viewBox={`0 0 ${containerWidth} 20`}
      preserveAspectRatio="none"
      style={{ left: 0, right: 0 }}
    >
      {bins.map((count, i) => {
        const barLo = i / NUM_BINS
        const barHi = (i + 1) / NUM_BINS
        const inRange = barHi >= valueLoPct && barLo <= valueHiPct
        const h = (Math.sqrt(count) / sqrtPeak) * 20
        const x = THUMB_RADIUS + barLo * trackWidth
        const w = (barHi - barLo) * trackWidth * 0.85
        return (
          <rect
            key={i}
            x={x}
            y={20 - h}
            width={w}
            height={h}
            className={inRange ? 'hist-bar-active' : 'hist-bar'}
          />
        )
      })}
    </svg>
  )
}

function DualSlider({ label, min, max, valueLo, valueHi, formatLo, formatHi, formatBoundLo, formatBoundHi, onLoChange, onHiChange, histogram, logScale }) {
  const sliderContainerRef = useRef(null)
  const [containerWidth, setContainerWidth] = useState(0)
  useLayoutEffect(() => {
    const el = sliderContainerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      setContainerWidth(Math.round(entries[0].contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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

  const posToValue = (pos) => {
    const ratio = pos / SLIDER_STEPS
    return Math.round(logScale ? fromLog(ratio, min, max) : min + ratio * (max - min))
  }

  // Radix reports both thumb positions on every drag. Map each back to a real
  // value, clearing a bound to null at its extreme so the slider reads "Any":
  //  - lo at 0 → no lower limit
  //  - hi at max → no upper limit. Pinning to a finite `max` would drop items
  //    whose value can't be compared — e.g. lots with no parseable end date
  //    filter to Infinity hours and would be excluded though the slider is full.
  const handleValueChange = ([loPos, hiPos]) => {
    onLoChange(loPos <= 0 ? null : posToValue(loPos))
    onHiChange(hiPos >= SLIDER_STEPS ? null : posToValue(hiPos))
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
      <div className="dual-slider" ref={sliderContainerRef}>
        {histogram && (
          <Histogram bins={histogram} valueLoPct={valueLoPct} valueHiPct={valueHiPct} containerWidth={containerWidth} />
        )}
        <Slider.Root
          className="range-slider-root"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={[sliderLo, sliderHi]}
          onValueChange={handleValueChange}
          minStepsBetweenThumbs={0}
        >
          <Slider.Track className="range-slider-track">
            <Slider.Range className="range-slider-range" />
          </Slider.Track>
          <Slider.Thumb className="range-slider-thumb range-slider-thumb-lo" aria-label={`${label} minimum`} />
          <Slider.Thumb className="range-slider-thumb range-slider-thumb-hi" aria-label={`${label} maximum`} />
        </Slider.Root>
      </div>
      <div className="range-bounds">
        <span>{formatBoundLo}</span>
        <span>{formatBoundHi}</span>
      </div>
    </div>
  )
}

// "Ends within" is multimodal (lots close in discrete auction-night bursts with
// multi-day gaps), so a continuous slider + histogram is noise. A few presets
// cover the only thing people actually want: "ending soon". Each preset sets the
// upper hours bound and clears the lower one; "All" clears both (so lots with no
// parseable end date — Infinity hours — aren't dropped).
const ENDS_WITHIN_PRESETS = [
  { key: 'day', label: '1 day', hours: 24 },
  { key: 'week', label: '1 week', hours: 24 * 7 },
  { key: 'all', label: 'All', hours: null },
]

function EndsWithinPresets({ maxHours, onMinHoursChange, onMaxHoursChange }) {
  const active = maxHours == null ? 'all'
    : maxHours === 24 ? 'day'
      : maxHours === 24 * 7 ? 'week'
        : null
  const select = (hours) => {
    onMinHoursChange(null)
    onMaxHoursChange(hours)
  }
  return (
    <div className="range-filter">
      <label className="range-label">Ends within</label>
      <div className="archive-segmented" role="group" aria-label="Ends within">
        {ENDS_WITHIN_PRESETS.map(opt => (
          <button
            key={opt.key}
            type="button"
            className={`segmented-option${active === opt.key ? ' active' : ''}`}
            aria-pressed={active === opt.key}
            onClick={() => select(opt.hours)}
          >{opt.label}</button>
        ))}
      </div>
    </div>
  )
}

export function RangeFilters({
  items,
  minPrice, maxPrice, onMinPriceChange, onMaxPriceChange,
  maxHours, onMinHoursChange, onMaxHoursChange,
  minBids, maxBids, onMinBidsChange, onMaxBidsChange,
  minBidders, maxBidders, onMinBiddersChange, onMaxBiddersChange,
}) {
  const { priceMax, bidsMax, biddersMax, priceHist, bidsHist, biddersHist } = useMemo(() => {
    let pMax = 0
    let bMax = 0
    let brMax = 0
    const prices = []
    const bidCounts = []
    const bidderCounts = []
    for (const item of items) {
      prices.push(item.currentBid)
      bidCounts.push(item.totalBids)
      bidderCounts.push(item.uniqueBidders ?? 0)
      if (item.currentBid > pMax) pMax = item.currentBid
      if (item.totalBids > bMax) bMax = item.totalBids
      const br = item.uniqueBidders ?? 0
      if (br > brMax) brMax = br
    }
    // Cap price/bids/bidders at the 99th percentile so a single outlier
    // (e.g. one $20k lot) doesn't compress everyone else into a sliver.
    const p99 = arr => {
      if (arr.length < 2) return arr[0] ?? 0
      const s = [...arr].sort((a, b) => a - b)
      return s[Math.floor(s.length * 0.99)]
    }
    pMax = Math.ceil(Math.max(p99(prices), 1))
    bMax = Math.ceil(Math.max(p99(bidCounts), 1))
    brMax = Math.ceil(Math.max(p99(bidderCounts), 1))
    return {
      priceMax: pMax,
      bidsMax: bMax,
      biddersMax: brMax,
      priceHist: buildHistogram(prices, 0, pMax, true),
      bidsHist: buildHistogram(bidCounts, 0, bMax, true),
      biddersHist: buildHistogram(bidderCounts, 0, brMax, true),
    }
  }, [items])

  if (!priceMax && !bidsMax && !biddersMax) return null

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
      {biddersMax > 0 && (
        <DualSlider
          label="Bidders"
          min={0}
          max={biddersMax}
          valueLo={minBidders ?? 0}
          valueHi={maxBidders ?? biddersMax}
          formatLo={formatBids}
          formatHi={formatBids}
          formatBoundLo="0"
          formatBoundHi={String(biddersMax)}
          onLoChange={onMinBiddersChange}
          onHiChange={onMaxBiddersChange}
          histogram={biddersHist}
          logScale
        />
      )}
      <EndsWithinPresets
        maxHours={maxHours}
        onMinHoursChange={onMinHoursChange}
        onMaxHoursChange={onMaxHoursChange}
      />
    </div>
  )
}
