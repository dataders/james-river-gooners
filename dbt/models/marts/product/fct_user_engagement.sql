-- Per-user engagement summary: favorites, ignores, activity cadence.
-- Grain: user_id.
with users as (
    select * from {{ ref('stg_users') }}
),

favs as (
    select
        user_id,
        count(*)                                                    as favorites_count,
        count(distinct auction_safe_id)                             as auctions_favorited,
        min(created_at)                                             as first_favorite_at,
        max(created_at)                                             as last_favorite_at,
        count(distinct favorited_date)                              as active_favorite_days,
        -- Most common hour for favoriting
        mode() within group (order by favorited_hour)              as peak_hour_favorites,
        -- Weekend vs weekday preference (0=Sun, 6=Sat)
        round(
            100.0 * sum(case when favorited_dow in (0,6) then 1 else 0 end) / count(*),
            1
        )                                                          as pct_weekend_favorites
    from {{ ref('stg_favorites') }}
    group by user_id
),

igns as (
    select
        user_id,
        count(*)                                                    as ignores_count,
        count(distinct auction_safe_id)                             as auctions_ignored,
        min(created_at)                                             as first_ignore_at,
        max(created_at)                                             as last_ignore_at,
        count(distinct ignored_date)                                as active_ignore_days
    from {{ ref('stg_ignored') }}
    group by user_id
)

select
    u.user_id,
    u.email,
    u.cannon_bidder_id,
    u.first_seen_at,
    u.last_sign_in_at,
    u.tenure_days,
    u.is_active_30d,
    u.has_bidder_id,

    -- Favorites
    coalesce(f.favorites_count, 0)                                 as favorites_count,
    coalesce(f.auctions_favorited, 0)                              as auctions_favorited,
    f.first_favorite_at,
    f.last_favorite_at,
    coalesce(f.active_favorite_days, 0)                            as active_favorite_days,
    f.peak_hour_favorites,
    f.pct_weekend_favorites,

    -- Ignores
    coalesce(i.ignores_count, 0)                                   as ignores_count,
    coalesce(i.auctions_ignored, 0)                                as auctions_ignored,
    i.first_ignore_at,
    i.last_ignore_at,
    coalesce(i.active_ignore_days, 0)                              as active_ignore_days,

    -- Combined engagement
    coalesce(f.favorites_count, 0)
        + coalesce(i.ignores_count, 0)                             as total_interactions,
    -- Decisiveness: how often does the user decide (fav or ignore) vs skip?
    -- Higher = more opinionated
    case
        when coalesce(f.favorites_count, 0)
           + coalesce(i.ignores_count, 0) > 0
        then round(
            100.0 * coalesce(f.favorites_count, 0)
            / (coalesce(f.favorites_count, 0) + coalesce(i.ignores_count, 0)),
            1
        )
    end                                                            as pct_favorites_of_decisions,
    -- Days from signup to first interaction
    case
        when least(f.first_favorite_at, i.first_ignore_at) is not null
        then round(
            extract(epoch from (
                least(f.first_favorite_at, i.first_ignore_at) - u.first_seen_at
            )) / 86400,
            1
        )
    end                                                            as days_to_first_interaction,

    -- Engagement tier
    case
        when coalesce(f.favorites_count, 0) + coalesce(i.ignores_count, 0) = 0
            then 'inactive'
        when coalesce(f.favorites_count, 0) + coalesce(i.ignores_count, 0) < 10
            then 'light'
        when coalesce(f.favorites_count, 0) + coalesce(i.ignores_count, 0) < 50
            then 'moderate'
        else
            'heavy'
    end                                                            as engagement_tier

from users u
left join favs f on f.user_id = u.user_id
left join igns i on i.user_id = u.user_id
