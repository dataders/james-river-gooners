-- Per-auction performance summary with category breakdown.
-- Grain: auction_safe_id.
with sold as (
    select * from {{ ref('stg_sold_lots') }}
),

-- Top category by GMV per auction
top_category as (
    select distinct on (auction_safe_id)
        auction_safe_id,
        category                                                    as top_category,
        sum(final_bid)                                             as top_cat_gmv
    from sold
    group by auction_safe_id, category
    order by auction_safe_id, sum(final_bid) desc
),

-- Category diversity (number of distinct categories)
auction_cats as (
    select
        auction_safe_id,
        count(distinct category)                                    as distinct_categories,
        array_agg(distinct category order by category)             as categories
    from sold
    group by auction_safe_id
),

base as (
    select
        s.auction_safe_id,
        max(s.auction_title)                                       as auction_title,
        max(s.auction_id)                                          as auction_id,
        max(s.source)                                              as source,
        max(s.sold_month)                                          as auction_month,
        max(s.sold_at)                                             as closed_at,

        -- Volume
        count(*)                                                   as lots_sold,
        sum(s.final_bid)                                           as total_gmv,

        -- Price distribution
        round(avg(s.final_bid)::numeric, 2)                        as avg_price,
        percentile_cont(0.5) within group (order by s.final_bid)  as median_price,
        max(s.final_bid)                                           as max_price,
        min(s.final_bid)                                           as min_price,

        -- Bidding dynamics
        round(avg(s.unique_bidders_safe)::numeric, 2)             as avg_unique_bidders,
        max(s.unique_bidders_safe)                                 as max_unique_bidders,
        round(avg(s.total_bids_safe)::numeric, 2)                 as avg_total_bids,
        max(s.total_bids_safe)                                     as max_total_bids,
        sum(case when s.is_competitive then 1 else 0 end)          as competitive_lots,
        round(
            100.0 * sum(case when s.is_competitive then 1 else 0 end) / count(*),
            1
        )                                                          as pct_competitive,

        -- Lots that sold above $100
        sum(case when s.final_bid >= 100 then 1 else 0 end)       as lots_over_100,
        sum(case when s.final_bid >= 500 then 1 else 0 end)       as lots_over_500

    from sold s
    group by s.auction_safe_id
)

select
    b.*,
    tc.top_category,
    tc.top_cat_gmv,
    ac.distinct_categories,
    ac.categories

from base b
left join top_category tc using (auction_safe_id)
left join auction_cats ac using (auction_safe_id)
order by b.closed_at desc
