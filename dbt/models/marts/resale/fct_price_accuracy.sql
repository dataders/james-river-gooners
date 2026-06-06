-- Comp accuracy: for sold lots with eBay or Cannon's comps, how well did the
-- comp predict the actual hammer price? Grain: (auction_safe_id, item_id).
-- This powers the "resale intelligence quality" view — is the comp system useful?
with sold_enriched as (
    select * from {{ ref('int_sold_lots_enriched') }}
    -- Only rows where at least one comp exists
    where has_ebay_comp or has_cannons_comp
)

select
    auction_safe_id,
    item_id,
    auction_title,
    lot_number,
    title,
    category,
    source,
    sold_at,
    sold_month,

    -- Actual outcome
    final_bid,
    total_bids_safe                                             as total_bids,
    unique_bidders_safe                                         as unique_bidders,
    is_competitive,

    -- Enrichment context
    brand,
    model_or_sku,
    condition,
    confidence,
    is_enriched,

    -- eBay comp accuracy
    has_ebay_comp,
    ebay_price,
    ebay_match_confidence,
    pct_vs_ebay_comp,
    -- Direction: did the item sell over or under eBay comp?
    case
        when pct_vs_ebay_comp >  10 then 'above_ebay'
        when pct_vs_ebay_comp < -10 then 'below_ebay'
        when pct_vs_ebay_comp is not null then 'near_ebay'
    end                                                         as ebay_comp_direction,
    -- Absolute accuracy (how far off, regardless of direction)
    abs(pct_vs_ebay_comp)                                       as ebay_comp_abs_error_pct,

    -- Cannon's comp accuracy
    has_cannons_comp,
    cannons_top_sold_price,
    cannons_top_similarity,
    pct_vs_cannons_comp,
    case
        when pct_vs_cannons_comp >  10 then 'above_cannons'
        when pct_vs_cannons_comp < -10 then 'below_cannons'
        when pct_vs_cannons_comp is not null then 'near_cannons'
    end                                                         as cannons_comp_direction,
    abs(pct_vs_cannons_comp)                                    as cannons_comp_abs_error_pct,

    -- Which comp was more accurate (when both exist)?
    case
        when has_ebay_comp and has_cannons_comp then
            case
                when abs(pct_vs_ebay_comp) <= abs(pct_vs_cannons_comp)
                then 'ebay_closer'
                else 'cannons_closer'
            end
        when has_ebay_comp    then 'ebay_only'
        when has_cannons_comp then 'cannons_only'
    end                                                         as better_comp_source

from sold_enriched
order by sold_at desc
