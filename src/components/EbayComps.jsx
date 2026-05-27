import { buildEbaySoldSearches, getEbayCompThumbnail, normalizeEbaySoldMatches } from '../utils/ebayComps'

export function EbayComps({ item, soldComps }) {
  const searches = buildEbaySoldSearches(item)
  const soldResults = normalizeEbaySoldMatches(soldComps)
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
            Search eBay
          </a>
        )}
      </div>
      <div className="ebay-comp-list">
        {soldResults.length > 0 ? (
          soldResults.slice(0, 3).map((comp, index) => {
            const thumbnail = getEbayCompThumbnail(comp, item)
            return (
              <a
                key={`${comp.itemWebUrl}:${index}`}
                href={comp.itemWebUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ebay-comp-card ebay-comp-card-sold"
              >
                <div className="ebay-comp-thumb" aria-hidden="true">
                  {thumbnail ? (
                    <img src={thumbnail} alt="" loading="lazy" />
                  ) : (
                    <span>eBay</span>
                  )}
                </div>
                <div className="ebay-comp-body">
                  <div className="ebay-comp-topline">
                    <span className="ebay-comp-price">{comp.priceLabel}</span>
                    {comp.dateLabel && <span className="ebay-comp-date">{comp.dateLabel}</span>}
                  </div>
                  <div className="ebay-comp-query">{comp.title}</div>
                  <div className="ebay-comp-meta">
                    {[comp.condition, comp.shippingLabel].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </a>
            )
          })
        ) : (
          sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ebay-comps-search"
            >
              Search eBay sold results
            </a>
          )
        )}
      </div>
    </section>
  )
}
