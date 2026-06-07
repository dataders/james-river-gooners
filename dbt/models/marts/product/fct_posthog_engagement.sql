-- Daily product engagement from PostHog behavioral events.
-- Grain: day.
-- Source: PostHog events exported via scraper/posthog_export.py → posthog_raw schema.
with events as (
    select * from {{ ref('stg_posthog_events') }}
),

search as (
    select * from {{ ref('stg_posthog_search_stats') }}
),

toggles as (
    select * from {{ ref('stg_posthog_toggle_stats') }}
),

-- Pivot key events into per-day columns
event_pivot as (
    select
        day,
        max(distinct_users)                                     as daily_active_users,
        sum(case when event = '$pageview'       then event_count else 0 end) as pageviews,
        sum(case when event = 'item_opened'     then event_count else 0 end) as item_opens,
        sum(case when event = 'archive_mode_changed' then event_count else 0 end) as archive_mode_changes,
        sum(case when event = 'enriched_filter_toggled' then event_count else 0 end) as enriched_filter_toggles,
        sum(case when event = 'swipe_deck_opened' then event_count else 0 end) as swipe_deck_opens
    from events
    group by day
),

-- Search totals per day
search_totals as (
    select
        day,
        sum(searches)                                           as total_searches,
        sum(case when is_semantic then searches else 0 end)    as semantic_searches,
        sum(case when not is_semantic then searches else 0 end) as keyword_searches,
        round(
            100.0 * sum(case when is_semantic then searches else 0 end)
            / nullif(sum(searches), 0), 1
        )                                                       as pct_semantic,
        round(avg(avg_query_length), 1)                        as avg_query_length,
        round(avg(avg_result_count), 0)::int                   as avg_result_count
    from search
    group by day
),

-- Toggle totals per day
toggle_totals as (
    select
        day,
        sum(case when event = 'favorite_toggled' and is_add then toggle_count else 0 end) as favorites_added,
        sum(case when event = 'favorite_toggled' and not is_add then toggle_count else 0 end) as favorites_removed,
        sum(case when event = 'ignored_toggled'  and is_add then toggle_count else 0 end) as ignores_added,
        sum(case when event = 'ignored_toggled'  and not is_add then toggle_count else 0 end) as ignores_removed,
        max(case when event = 'ignored_toggled' and is_add then distinct_users else 0 end) as ignore_users
    from toggles
    group by day
),

-- All days across any source
all_days as (
    select day from event_pivot
    union
    select day from search_totals
    union
    select day from toggle_totals
)

select
    d.day,

    -- Activity volume
    coalesce(e.daily_active_users, 0)                           as daily_active_users,
    coalesce(e.pageviews, 0)                                    as pageviews,
    coalesce(e.item_opens, 0)                                   as item_opens,
    coalesce(e.archive_mode_changes, 0)                         as archive_mode_changes,
    coalesce(e.enriched_filter_toggles, 0)                      as enriched_filter_toggles,
    coalesce(e.swipe_deck_opens, 0)                             as swipe_deck_opens,

    -- Search behaviour
    coalesce(s.total_searches, 0)                               as total_searches,
    coalesce(s.semantic_searches, 0)                            as semantic_searches,
    coalesce(s.keyword_searches, 0)                             as keyword_searches,
    s.pct_semantic,
    s.avg_query_length,
    s.avg_result_count,

    -- Curation decisions
    coalesce(t.favorites_added, 0)                              as favorites_added,
    coalesce(t.favorites_removed, 0)                            as favorites_removed,
    coalesce(t.ignores_added, 0)                                as ignores_added,
    coalesce(t.ignores_removed, 0)                              as ignores_removed,

    -- Derived: decision rate — how many curation decisions per active user
    case
        when coalesce(e.daily_active_users, 0) > 0
        then round(
            (coalesce(t.favorites_added, 0) + coalesce(t.ignores_added, 0))::numeric
            / e.daily_active_users, 2)
    end                                                         as decisions_per_user,

    -- Derived: ignore dominance (what fraction of add-decisions were ignores)
    case
        when coalesce(t.favorites_added, 0) + coalesce(t.ignores_added, 0) > 0
        then round(
            100.0 * coalesce(t.ignores_added, 0)
            / (coalesce(t.favorites_added, 0) + coalesce(t.ignores_added, 0)), 1)
    end                                                         as pct_ignores_of_decisions

from all_days d
left join event_pivot   e using (day)
left join search_totals s using (day)
left join toggle_totals t using (day)
order by day desc
