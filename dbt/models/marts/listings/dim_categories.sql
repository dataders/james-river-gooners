-- One row per category. Aggregates lifetime stats from all sold lots.
-- Grain: category.
with sold as (
    select * from {{ ref('stg_sold_lots') }}
),

stats as (
    select
        category,
        count(*)                                                    as lifetime_lots_sold,
        count(distinct auction_safe_id)                             as auctions_appeared_in,
        count(distinct source)                                      as sources_seen_in,
        sum(final_bid)                                              as lifetime_gmv,
        round(avg(final_bid)::numeric, 2)                          as avg_price,
        percentile_cont(0.5) within group (order by final_bid)     as median_price,
        percentile_cont(0.25) within group (order by final_bid)    as p25_price,
        percentile_cont(0.75) within group (order by final_bid)    as p75_price,
        max(final_bid)                                             as max_price,
        min(final_bid)                                             as min_price,
        round(avg(unique_bidders_safe)::numeric, 2)                as avg_unique_bidders,
        round(avg(total_bids_safe)::numeric, 2)                    as avg_total_bids,
        round(
            100.0 * sum(case when is_competitive then 1 else 0 end) / count(*),
            1
        )                                                          as pct_competitive,
        min(sold_at)                                               as first_seen_at,
        max(sold_at)                                               as last_seen_at,
        count(distinct sold_month)                                  as months_active

    from sold
    group by category
)

select
    category,
    lifetime_lots_sold,
    auctions_appeared_in,
    sources_seen_in,
    lifetime_gmv,
    avg_price,
    median_price,
    p25_price,
    p75_price,
    max_price,
    min_price,
    avg_unique_bidders,
    avg_total_bids,
    pct_competitive,
    first_seen_at,
    last_seen_at,
    months_active,
    -- Price volatility (IQR / median): higher = wider spread
    case when median_price > 0
        then round(((p75_price - p25_price) / median_price * 100)::numeric, 1)
    end                                                            as price_iqr_pct

from stats
order by lifetime_gmv desc
