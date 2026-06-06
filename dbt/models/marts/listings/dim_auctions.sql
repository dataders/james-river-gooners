-- One row per auction. Derived from sold_lots so only auctions with at least
-- one sold lot appear. Grain: auction_safe_id.
with sold as (
    select * from {{ ref('stg_sold_lots') }}
)

select
    auction_safe_id,
    max(auction_title)                                          as auction_title,
    max(auction_id)                                            as auction_id,
    max(source)                                                as source,
    min(sold_at)                                               as auction_start_at,
    max(sold_at)                                               as auction_end_at,
    date_trunc('month', max(sold_at))::date                    as auction_month,
    count(*)                                                   as lots_sold,
    sum(final_bid)                                             as total_gmv,
    round(avg(final_bid)::numeric, 2)                          as avg_price,
    percentile_cont(0.5) within group (order by final_bid)     as median_price,
    max(final_bid)                                             as max_price,
    min(final_bid)                                             as min_price,
    round(avg(unique_bidders_safe)::numeric, 1)                as avg_unique_bidders,
    round(avg(total_bids_safe)::numeric, 1)                    as avg_total_bids,
    sum(case when is_competitive then 1 else 0 end)            as competitive_lots,
    round(
        100.0 * sum(case when is_competitive then 1 else 0 end) / count(*),
        1
    )                                                          as pct_competitive,
    count(distinct category)                                   as distinct_categories

from sold
group by auction_safe_id
