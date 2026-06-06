-- eBay comp coverage and freshness per auction.
-- Tells you: what % of lots have comps, how old are they, which query strategy wins.
-- Grain: (auction_safe_id, source_query).
with lots as (
    -- All lots (active + archived) as the denominator
    select
        auction_safe_id,
        item_id,
        auction_title,
        source
    from {{ ref('stg_lots') }}
),

-- Latest comp per (auction, item, source_query)
latest_comps as (
    select distinct on (auction_safe_id, item_id, source_query)
        auction_safe_id,
        item_id,
        source_query,
        ebay_price,
        match_confidence,
        fetched_at,
        comp_age_days
    from {{ ref('stg_ebay_comp_snapshots') }}
    order by auction_safe_id, item_id, source_query, fetched_at desc
),

-- Aggregate coverage stats per auction × source_query
comp_stats as (
    select
        lc.auction_safe_id,
        lc.source_query,
        count(distinct lc.item_id)                                  as items_with_comp,
        round(avg(lc.ebay_price)::numeric, 2)                      as avg_comp_price,
        percentile_cont(0.5) within group (order by lc.ebay_price) as median_comp_price,
        round(avg(lc.comp_age_days)::numeric, 1)                   as avg_comp_age_days,
        max(lc.fetched_at)                                         as last_fetched_at,
        sum(case when lc.match_confidence = 'high'   then 1 else 0 end) as high_conf_comps,
        sum(case when lc.match_confidence = 'medium' then 1 else 0 end) as medium_conf_comps,
        sum(case when lc.match_confidence = 'low'    then 1 else 0 end) as low_conf_comps
    from latest_comps lc
    group by lc.auction_safe_id, lc.source_query
),

-- Total lots per auction for the denominator
auction_totals as (
    select
        auction_safe_id,
        max(auction_title)                                          as auction_title,
        max(source)                                                 as source,
        count(distinct item_id)                                     as total_lots
    from lots
    group by auction_safe_id
)

select
    at_.auction_safe_id,
    at_.auction_title,
    at_.source,
    at_.total_lots,
    cs.source_query,
    coalesce(cs.items_with_comp, 0)                                as items_with_comp,
    round(
        100.0 * coalesce(cs.items_with_comp, 0) / nullif(at_.total_lots, 0),
        1
    )                                                              as coverage_pct,
    cs.avg_comp_price,
    cs.median_comp_price,
    cs.avg_comp_age_days,
    cs.last_fetched_at,
    coalesce(cs.high_conf_comps, 0)                                as high_conf_comps,
    coalesce(cs.medium_conf_comps, 0)                              as medium_conf_comps,
    coalesce(cs.low_conf_comps, 0)                                 as low_conf_comps,
    round(
        100.0 * coalesce(cs.high_conf_comps, 0)
        / nullif(cs.items_with_comp, 0),
        1
    )                                                              as pct_high_confidence

from auction_totals at_
left join comp_stats cs using (auction_safe_id)
order by at_.auction_safe_id, cs.source_query
