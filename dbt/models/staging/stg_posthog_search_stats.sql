-- Daily search-event stats split by semantic vs keyword mode.
-- Grain: (day, semantic).
with source as (
    select * from {{ source('posthog_raw', 'search_stats') }}
)

select
    day::date                               as day,
    coalesce(semantic::boolean, false)      as is_semantic,
    searches::int                           as searches,
    round(avg_query_length::double, 1)      as avg_query_length,
    round(avg_result_count::double, 0)::int as avg_result_count
from source
