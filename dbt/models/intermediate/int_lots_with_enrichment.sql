-- All lots (active + archived) joined to LLM enrichment.
-- Grain: one row per lot.
with lots as (
    select * from {{ ref('stg_lots') }}
),

enrichment as (
    select * from {{ ref('stg_lot_enrichment') }}
)

select
    l.auction_safe_id,
    l.item_id,
    l.auction_id,
    l.auction_title,
    l.lot_number,
    l.title,
    l.description,
    l.category,
    l.raw_category,
    l.source,
    l.archived,
    l.closed,
    l.current_bid,
    l.final_bid,
    l.total_bids,
    l.unique_bidders,
    l.image_count,
    l.detail_url,
    l.scraped_at,
    l.updated_at,
    l.end_date,
    l.auction_end_date,

    -- Enrichment fields (null when lot was not identified)
    e.brand,
    e.model_or_sku,
    e.condition,
    e.product_url,
    e.confidence,
    e.confidence_rank,
    e.enrichment_model,
    e.has_brand,
    e.has_model,
    e.has_product_url,

    -- Flags
    e.item_id is not null                   as is_enriched,
    coalesce(e.confidence_rank, 0) >= 1     as is_identified   -- medium or high

from lots l
left join enrichment e
    using (auction_safe_id, item_id)
