-- Category performance trends: rolling averages, multi-period comparisons, and
-- volume rankings. Builds on fct_category_monthly_stats — run that first.
-- Grain: (category, sold_month, source).
with monthly as (
    select * from {{ ref('fct_category_monthly_stats') }}
),

with_rolling as (
    select
        *,

        -- 3-month rolling median price (smooths single-auction spikes)
        avg(median_price) over (
            partition by category, source
            order by sold_month
            rows between 2 preceding and current row
        )                                                           as rolling_3m_median_price,

        -- 3-month rolling average lot volume
        avg(lots_sold) over (
            partition by category, source
            order by sold_month
            rows between 2 preceding and current row
        )                                                           as rolling_3m_avg_lots,

        -- 3-month rolling average unique bidders (engagement trend)
        avg(avg_unique_bidders) over (
            partition by category, source
            order by sold_month
            rows between 2 preceding and current row
        )                                                           as rolling_3m_avg_bidders,

        -- 3-month rolling competitive rate
        avg(pct_competitive) over (
            partition by category, source
            order by sold_month
            rows between 2 preceding and current row
        )                                                           as rolling_3m_pct_competitive,

        -- Volume rank among all categories this month (1 = most lots)
        rank() over (
            partition by sold_month, source
            order by lots_sold desc
        )                                                           as volume_rank,

        -- Price rank among all categories this month (1 = highest median)
        rank() over (
            partition by sold_month, source
            order by median_price desc
        )                                                           as price_rank,

        -- Values from 3 months ago for period comparison
        lag(lots_sold, 3) over (
            partition by category, source
            order by sold_month
        )                                                           as lots_sold_3m_ago,

        lag(median_price, 3) over (
            partition by category, source
            order by sold_month
        )                                                           as median_price_3m_ago,

        lag(avg_unique_bidders, 3) over (
            partition by category, source
            order by sold_month
        )                                                           as avg_bidders_3m_ago,

        -- Values from 12 months ago for year-over-year
        lag(lots_sold, 12) over (
            partition by category, source
            order by sold_month
        )                                                           as lots_sold_12m_ago,

        lag(median_price, 12) over (
            partition by category, source
            order by sold_month
        )                                                           as median_price_12m_ago,

        -- Volume rank 3 months ago (detect rising/falling categories)
        lag(rank() over (
            partition by sold_month, source
            order by lots_sold desc
        ), 3) over (
            partition by category, source
            order by sold_month
        )                                                           as volume_rank_3m_ago

    from monthly
)

select
    category,
    sold_month,
    year,
    month,
    source,

    -- Raw monthly stats (pass-through)
    lots_sold,
    auctions,
    gmv,
    avg_price,
    median_price,
    p25_price,
    p75_price,
    max_price,
    avg_unique_bidders,
    avg_total_bids,
    competitive_lots,
    pct_competitive,

    -- Rolling averages
    round(rolling_3m_median_price, 2)                              as rolling_3m_median_price,
    round(rolling_3m_avg_lots, 1)                                  as rolling_3m_avg_lots,
    round(rolling_3m_avg_bidders, 2)                               as rolling_3m_avg_bidders,
    round(rolling_3m_pct_competitive, 1)                           as rolling_3m_pct_competitive,

    -- Current rankings
    volume_rank,
    price_rank,

    -- 3-month change: volume
    lots_sold_3m_ago,
    case when lots_sold_3m_ago > 0
        then round(100.0 * (lots_sold - lots_sold_3m_ago) / lots_sold_3m_ago, 1)
    end                                                            as volume_3m_pct_change,

    -- 3-month change: price
    median_price_3m_ago,
    case when median_price_3m_ago > 0
        then round(100.0 * (median_price - median_price_3m_ago) / median_price_3m_ago, 1)
    end                                                            as price_3m_pct_change,

    -- 3-month change: bidder engagement
    avg_bidders_3m_ago,
    case when avg_bidders_3m_ago > 0
        then round(100.0 * (avg_unique_bidders - avg_bidders_3m_ago) / avg_bidders_3m_ago, 1)
    end                                                            as bidders_3m_pct_change,

    -- Year-over-year
    lots_sold_12m_ago,
    case when lots_sold_12m_ago > 0
        then round(100.0 * (lots_sold - lots_sold_12m_ago) / lots_sold_12m_ago, 1)
    end                                                            as volume_yoy_pct_change,

    median_price_12m_ago,
    case when median_price_12m_ago > 0
        then round(100.0 * (median_price - median_price_12m_ago) / median_price_12m_ago, 1)
    end                                                            as price_yoy_pct_change,

    -- Momentum signal: is this category growing or shrinking in volume?
    volume_rank_3m_ago,
    case
        when volume_rank_3m_ago is null         then 'new'
        when volume_rank < volume_rank_3m_ago   then 'rising'
        when volume_rank > volume_rank_3m_ago   then 'falling'
        else                                         'stable'
    end                                                            as volume_momentum,

    -- Price trend signal (vs rolling baseline)
    case
        when rolling_3m_median_price is null or rolling_3m_median_price = 0 then null
        when median_price > rolling_3m_median_price * 1.05  then 'above_trend'
        when median_price < rolling_3m_median_price * 0.95  then 'below_trend'
        else                                                      'on_trend'
    end                                                            as price_trend_signal

from with_rolling
order by category, source, sold_month
