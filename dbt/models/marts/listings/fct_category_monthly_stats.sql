-- Historical listing stats per category × month.
-- Grain: (category, sold_month).  Perfect for time-series charts.
with sold as (
    select * from {{ ref('stg_sold_lots') }}
),

monthly as (
    select
        category,
        sold_month,
        extract(year from sold_month)::int                          as year,
        extract(month from sold_month)::int                         as month,
        source,

        count(*)                                                    as lots_sold,
        count(distinct auction_safe_id)                             as auctions,
        sum(final_bid)                                              as gmv,
        round(avg(final_bid)::numeric, 2)                          as avg_price,
        percentile_cont(0.5) within group (order by final_bid)     as median_price,
        percentile_cont(0.25) within group (order by final_bid)    as p25_price,
        percentile_cont(0.75) within group (order by final_bid)    as p75_price,
        max(final_bid)                                             as max_price,
        min(final_bid)                                             as min_price,

        round(avg(unique_bidders_safe)::numeric, 2)                as avg_unique_bidders,
        max(unique_bidders_safe)                                   as max_unique_bidders,
        round(avg(total_bids_safe)::numeric, 2)                    as avg_total_bids,
        max(total_bids_safe)                                       as max_total_bids,

        sum(case when is_competitive then 1 else 0 end)            as competitive_lots,
        round(
            100.0 * sum(case when is_competitive then 1 else 0 end) / count(*),
            1
        )                                                          as pct_competitive

    from sold
    group by category, sold_month, source
),

-- Month-over-month median price change
with_mom as (
    select
        *,
        lag(median_price) over (
            partition by category, source
            order by sold_month
        )                                                           as prev_median_price,
        lag(lots_sold) over (
            partition by category, source
            order by sold_month
        )                                                           as prev_lots_sold

    from monthly
)

select
    category,
    sold_month,
    year,
    month,
    source,
    lots_sold,
    auctions,
    gmv,
    avg_price,
    median_price,
    p25_price,
    p75_price,
    max_price,
    min_price,
    avg_unique_bidders,
    max_unique_bidders,
    avg_total_bids,
    max_total_bids,
    competitive_lots,
    pct_competitive,
    prev_median_price,
    prev_lots_sold,
    -- Month-over-month % change in median price
    case when prev_median_price > 0
        then round(
            ((median_price - prev_median_price) / prev_median_price * 100)::numeric,
            1
        )
    end                                                             as median_price_mom_pct,
    -- Month-over-month % change in volume
    case when prev_lots_sold > 0
        then round(
            ((lots_sold - prev_lots_sold)::numeric / prev_lots_sold * 100),
            1
        )
    end                                                             as lots_sold_mom_pct

from with_mom
order by category, sold_month
