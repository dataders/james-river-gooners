import { buildEbaySoldSearches } from '../utils/ebayComps'

function compThumb(comp, item) {
  return comp.thumbnailUrl || comp.imageUrl || item.images?.[0] || ''
}

function formatPrice(comp) {
  if (comp.soldPrice) return comp.soldPrice
  if (!comp.price?.value) return ''
  const value = Number(comp.price.value)
  if (comp.price.currency === 'USD' && Number.isFinite(value)) {
    return `$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`
  }
  return `${comp.price.value} ${comp.price.currency || ''}`.trim()
}

function formatDate(comp) {
  return comp.soldDateLabel || comp.soldDate || ''
}

export function EbayComps({ item, soldComps }) {
  const searches = buildEbaySoldSearches(item)
  const soldResults = (soldComps?.matches || soldComps?.results || [])
    .filter(result => result.title && formatPrice(result))
  if (searches.length === 0 && soldResults.length === 0) return null
  const sourceUrl = soldComps?.searchUrl || soldComps?.sourceUrl || searches[0]?.url

  return (
    <section className="ebay-comps">
      <div className="ebay-comps-header">
        <h3>eBay sold comps</h3>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ebay-comps-all"
          >
            Open eBay
          </a>
        )}
      </div>
      <div className="ebay-comp-list">
        {soldResults.length > 0 ? (
          soldResults.slice(0, 3).map((comp, index) => (
            <a
              key={`${comp.itemWebUrl || comp.url || comp.title}:${index}`}
              href={comp.itemWebUrl || comp.url || sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ebay-comp-card ebay-comp-card-sold"
            >
              <div className="ebay-comp-thumb" aria-hidden="true">
                {compThumb(comp, item) ? (
                  <img src={compThumb(comp, item)} alt="" loading="lazy" />
                ) : (
                  <span>eBay</span>
                )}
              </div>
              <div className="ebay-comp-body">
                <div className="ebay-comp-topline">
                  <span className="ebay-comp-price">{formatPrice(comp)}</span>
                  {formatDate(comp) && <span className="ebay-comp-date">{formatDate(comp)}</span>}
                </div>
                <div className="ebay-comp-query">{comp.title}</div>
                <div className="ebay-comp-meta">
                  {[comp.condition, comp.shippingLabel || comp.shipping].filter(Boolean).join(' · ')}
                </div>
              </div>
            </a>
          ))
        ) : (
          searches.map(search => (
            <a
              key={`${search.kind}:${search.query}`}
              href={search.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ebay-comp-card"
            >
              <div className="ebay-comp-thumb" aria-hidden="true">
                {item.images?.[0] ? (
                  <img src={item.images[0]} alt="" loading="lazy" />
                ) : (
                  <span>eBay</span>
                )}
              </div>
              <div className="ebay-comp-body">
                <div className="ebay-comp-label">{search.label}</div>
                <div className="ebay-comp-query">{search.query}</div>
                {search.warning && (
                  <div className="ebay-comp-warning">{search.warning}</div>
                )}
              </div>
            </a>
          ))
        )}
      </div>
    </section>
  )
}
