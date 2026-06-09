with source as (
    select * from {{ source('github_stats', 'commits') }}
)

select
    -- Keys
    sha                                         as commit_sha,

    -- Content
    author_login,
    author_name,
    message,
    html_url,

    -- Timestamps + derived dimensions
    authored_at,
    date_trunc('day', authored_at)::date        as authored_date,
    date_trunc('week', authored_at)::date       as authored_week

from source
