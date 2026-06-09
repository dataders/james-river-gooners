with source as (
    select * from {{ source('github_stats', 'pull_requests') }}
)

select
    -- Keys
    id                                          as pr_id,
    number                                      as pr_number,

    -- Content
    title,
    user_login,
    base_ref,
    state,
    html_url,

    -- Status
    draft,
    merged,
    state = 'closed' and not merged             as closed_unmerged,

    -- Merge timing
    hours_to_merge,
    round((hours_to_merge / 24.0)::numeric, 2)  as days_to_merge,

    -- Timestamps + derived dimensions
    created_at,
    merged_at,
    closed_at,
    updated_at,
    date_trunc('day', created_at)::date         as opened_date,
    date_trunc('day', merged_at)::date          as merged_date

from source
