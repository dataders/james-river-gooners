-- Per-item engagement: how many users favorited/ignored each lot, and whether
-- the crowd was right (did heavily-favorited lots sell above median?).
-- Grain: (auction_safe_id, item_id).
with favs as (
    select
        auction_safe_id,
        item_id,
        count(distinct user_id)                                     as favorited_by,
        min(created_at)                                             as first_favorited_at,
        max(created_at)                                             as last_favorited_at
    from {{ ref('stg_favorites') }}
    group by auction_safe_id, item_id
),

igns as (
    select
        auction_safe_id,
        item_id,
        count(distinct user_id)                                     as ignored_by,
        min(created_at)                                             as first_ignored_at
    from {{ ref('stg_ignored') }}
    group by auction_safe_id, item_id
),

-- Sold lots to check if favorited items actually sold well
sold as (
    select
        auction_safe_id,
        item_id,
        title,
        category,
        source,
        final_bid,
        total_bids_safe                                             as total_bids,
        unique_bidders_safe                                         as unique_bidders,
        sold_at,
        price_bucket,
        is_competitive
    from {{ ref('stg_sold_lots') }}
),

-- Category median to benchmark individual lots
cat_median as (
    select
        category,
        percentile_cont(0.5) within group (order by final_bid)     as category_median_price
    from sold
    group by category
),

-- Union all items that have any engagement
all_items as (
    select auction_safe_id, item_id from favs
    union
    select auction_safe_id, item_id from igns
)

select
    a.auction_safe_id,
    a.item_id,

    -- Engagement signals
    coalesce(f.favorited_by, 0)                                    as favorited_by,
    coalesce(i.ignored_by, 0)                                      as ignored_by,
    coalesce(f.favorited_by, 0) - coalesce(i.ignored_by, 0)       as net_score,
    f.first_favorited_at,
    f.last_favorited_at,
    i.first_ignored_at,

    -- Sold data (null if the lot hasn't sold or isn't in sold_lots)
    s.title,
    s.category,
    s.source,
    s.final_bid,
    s.total_bids,
    s.unique_bidders,
    s.sold_at,
    s.price_bucket,
    s.is_competitive,

    -- Did the crowd wisdom hold?
    cm.category_median_price,
    case
        when s.final_bid is not null and cm.category_median_price > 0
        then round(
            ((s.final_bid - cm.category_median_price) / cm.category_median_price * 100)::numeric,
            1
        )
    end                                                            as pct_above_category_median,

    -- Engagement-weighted desirability
    case
        when coalesce(f.favorited_by, 0) + coalesce(i.ignored_by, 0) = 0 then null
        else round(
            100.0 * coalesce(f.favorited_by, 0)
            / (coalesce(f.favorited_by, 0) + coalesce(i.ignored_by, 0)),
            1
        )
    end                                                            as pct_approval

from all_items a
left join favs f using (auction_safe_id, item_id)
left join igns i using (auction_safe_id, item_id)
left join sold s using (auction_safe_id, item_id)
left join cat_median cm on cm.category = s.category
