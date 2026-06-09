-- True issues only. GitHub's issues endpoint also returns pull requests, so
-- is_pull_request rows are excluded here (PRs live in stg_github_pull_requests).
with source as (
    select * from {{ source('github_stats', 'issues') }}
)

select
    -- Keys
    id                                          as issue_id,
    number                                      as issue_number,

    -- Content
    title,
    user_login,
    state,
    comments,
    html_url,

    -- Timestamps + derived dimensions
    created_at,
    closed_at,
    updated_at,
    date_trunc('day', created_at)::date         as opened_date,
    date_trunc('day', closed_at)::date          as closed_date

from source
where not is_pull_request
