-- Closed lots joined to LLM enrichment and latest eBay comp.
-- Grain: one row per sold lot.
with sold as (
    select * from {{ ref('stg_sold_lots') }}
),

enrichment as (
    select * from {{ ref('stg_lot_enrichment') }}
),

-- Best single eBay comp per lot: highest-confidence, most-recent fetch
ebay_best as (
    select distinct on (auction_safe_id, item_id)
        auction_safe_id,
        item_id,
        ebay_price,
        ebay_sold_date,
        match_confidence,
        source_query,
        fetched_at
    from {{ ref('stg_ebay_comp_snapshots') }}
    order by
        auction_safe_id,
        item_id,
        case match_confidence when 'high' then 0 when 'medium' then 1 else 2 end,
        fetched_at desc
),

-- Top Cannon's comp (rank 0) per lot
cannons_top as (
    select
        auction_safe_id,
        item_id,
        sold_price                          as cannons_top_sold_price,
        similarity                          as cannons_top_similarity,
        match_title                         as cannons_top_match_title
    from {{ ref('stg_cannons_comp_snapshots') }}
    where comp_rank = 0
)

select
    s.*,

    -- Enrichment
    e.brand,
    e.model_or_sku,
    e.condition,
    e.confidence,
    e.confidence_rank,
    e.has_brand,
    e.has_model,
    e.item_id is not null                   as is_enriched,

    -- eBay comp
    eb.ebay_price,
    eb.ebay_sold_date,
    eb.match_confidence                     as ebay_match_confidence,
    eb.item_id is not null                  as has_ebay_comp,
    -- Premium/discount vs eBay comp (positive = sold above eBay)
    case
        when eb.ebay_price > 0
        then round(((s.final_bid - eb.ebay_price) / eb.ebay_price * 100)::numeric, 1)
    end                                     as pct_vs_ebay_comp,

    -- Cannon's comp
    cc.cannons_top_sold_price,
    cc.cannons_top_similarity,
    cc.cannons_top_match_title,
    cc.item_id is not null                  as has_cannons_comp

from sold s
left join enrichment e
    using (auction_safe_id, item_id)
left join ebay_best eb
    using (auction_safe_id, item_id)
left join cannons_top cc
    using (auction_safe_id, item_id)
