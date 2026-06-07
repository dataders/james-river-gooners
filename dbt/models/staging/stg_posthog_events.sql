-- Daily PostHog event counts exported by scraper/posthog_export.py.
-- Grain: (day, event).
with source as (
    select * from {{ source('posthog_raw', 'events_daily') }}
),

cleaned as (
    select
        day::date                           as day,
        event,
        cnt::int                            as event_count,
        distinct_users::int                 as distinct_users
    from source
)

select * from cleaned
