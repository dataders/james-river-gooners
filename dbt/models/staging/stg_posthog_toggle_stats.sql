-- Daily favorite/ignore toggle counts.
-- Grain: (day, event, adding, signed_in).
with source as (
    select * from {{ source('posthog_raw', 'toggle_stats') }}
)

select
    day::date                               as day,
    event,
    coalesce(adding::boolean, false)        as is_add,
    coalesce(signed_in::boolean, false)     as is_signed_in,
    cnt::int                                as toggle_count,
    distinct_users::int                     as distinct_users
from source
