-- LLM enrichment coverage per auction.
-- Grain: auction_safe_id.
with lots as (
    select
        auction_safe_id,
        item_id,
        auction_title,
        source
    from {{ ref('stg_lots') }}
),

enrichment as (
    select * from {{ ref('stg_lot_enrichment') }}
),

auction_totals as (
    select
        auction_safe_id,
        max(auction_title)                                          as auction_title,
        max(source)                                                 as source,
        count(distinct item_id)                                     as total_lots
    from lots
    group by auction_safe_id
),

enrichment_stats as (
    select
        auction_safe_id,
        count(*)                                                    as enriched_lots,
        sum(case when confidence = 'high'   then 1 else 0 end)     as high_conf_lots,
        sum(case when confidence = 'medium' then 1 else 0 end)     as medium_conf_lots,
        sum(case when has_brand   then 1 else 0 end)               as lots_with_brand,
        sum(case when has_model   then 1 else 0 end)               as lots_with_model,
        sum(case when has_product_url then 1 else 0 end)           as lots_with_product_url,
        count(distinct enrichment_model)                           as distinct_models_used,
        -- DuckDB: mode(col) without ordered-set syntax
        mode(enrichment_model)                                      as primary_model,
        min(updated_at)                                             as first_enriched_at,
        max(updated_at)                                             as last_enriched_at

    from enrichment
    group by auction_safe_id
)

select
    at_.auction_safe_id,
    at_.auction_title,
    at_.source,
    at_.total_lots,

    coalesce(es.enriched_lots, 0)                                  as enriched_lots,
    round(
        100.0 * coalesce(es.enriched_lots, 0) / nullif(at_.total_lots, 0),
        1
    )                                                              as enrichment_coverage_pct,

    coalesce(es.high_conf_lots, 0)                                 as high_conf_lots,
    coalesce(es.medium_conf_lots, 0)                               as medium_conf_lots,
    round(
        100.0 * coalesce(es.high_conf_lots, 0)
        / nullif(es.enriched_lots, 0),
        1
    )                                                              as pct_high_confidence,

    coalesce(es.lots_with_brand, 0)                               as lots_with_brand,
    coalesce(es.lots_with_model, 0)                               as lots_with_model,
    coalesce(es.lots_with_product_url, 0)                         as lots_with_product_url,
    round(
        100.0 * coalesce(es.lots_with_brand, 0) / nullif(es.enriched_lots, 0),
        1
    )                                                              as pct_brand_extracted,
    round(
        100.0 * coalesce(es.lots_with_model, 0) / nullif(es.enriched_lots, 0),
        1
    )                                                              as pct_model_extracted,

    es.distinct_models_used,
    es.primary_model,
    es.first_enriched_at,
    es.last_enriched_at

from auction_totals at_
left join enrichment_stats es using (auction_safe_id)
order by at_.auction_safe_id
