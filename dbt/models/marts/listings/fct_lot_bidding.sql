-- One row per sold lot with bidding dynamics and enrichment context.
-- The grain is the individual lot — use this to explore what drives price.
with enriched as (
    select * from {{ ref('int_sold_lots_enriched') }}
)

select
    -- Identity
    auction_safe_id,
    item_id,
    auction_id,
    auction_title,
    lot_number,
    title,
    category,
    source,

    -- Financials
    final_bid,
    price_bucket,
    total_bids_safe                                             as total_bids,
    unique_bidders_safe                                         as unique_bidders,

    -- Bidding intensity ratios
    case when unique_bidders_safe > 0
        then round((total_bids_safe::numeric / unique_bidders_safe), 2)
    end                                                         as bids_per_bidder,
    case when total_bids_safe > 0
        then round((final_bid / total_bids_safe)::numeric, 2)
    end                                                         as price_per_bid,

    -- Flags
    is_competitive,

    -- Time
    sold_at,
    sold_month,
    sold_quarter,
    sold_year,
    sold_dow,
    sold_hour,

    -- Enrichment context
    brand,
    model_or_sku,
    condition,
    confidence,
    is_enriched,
    has_brand,
    has_model,

    -- Comp benchmarks
    has_ebay_comp,
    ebay_price,
    pct_vs_ebay_comp,
    ebay_match_confidence,
    has_cannons_comp,
    cannons_top_sold_price,
    cannons_top_similarity,

    -- Price vs Cannon's historical comp
    case when cannons_top_sold_price > 0
        then round(
            ((final_bid - cannons_top_sold_price) / cannons_top_sold_price * 100)::numeric,
            1
        )
    end                                                         as pct_vs_cannons_comp

from enriched
