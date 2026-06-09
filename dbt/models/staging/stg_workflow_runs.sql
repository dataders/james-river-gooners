with source as (
    select * from {{ source('github_stats', 'workflow_runs') }}
)

select
    -- Keys
    id                                          as run_id,
    workflow_id,
    run_number,
    run_attempt,

    -- Content
    name                                        as workflow_name,
    head_branch,
    event,
    status,
    conclusion,
    html_url,

    -- Outcome flags (precomputed in the pipeline from conclusion)
    succeeded,
    failed,

    -- Timing
    duration_seconds,
    round((duration_seconds / 60.0)::numeric, 2) as duration_minutes,

    -- Timestamps + derived dimensions
    created_at,
    run_started_at,
    updated_at,
    date_trunc('day', created_at)::date         as run_date,
    date_trunc('week', created_at)::date        as run_week,
    extract(hour from created_at)::int          as run_hour,
    extract(dow from created_at)::int           as run_dow   -- 0 = Sunday

from source
