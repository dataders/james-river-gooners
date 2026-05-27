import { buildEbaySoldSearches } from '../utils/ebayComps'

export function EbayComps({ item }) {
  const searches = buildEbaySoldSearches(item)
  if (searches.length === 0) return null

  return (
    <section className="ebay-comps">
      <div className="ebay-comps-header">
        <h3>eBay sold comps</h3>
        <a
          href={searches[0].url}
          target="_blank"
          rel="noopener noreferrer"
          className="ebay-comps-all"
        >
          Open eBay
        </a>
      </div>
      <div className="ebay-comp-list">
        {searches.map(search => (
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
        ))}
      </div>
    </section>
  )
}
