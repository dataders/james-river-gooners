-- One row per pull request, with merge timing and a merge-speed bucket.
-- Drill-down companion to the daily rollup in fct_repo_activity_daily.
with prs as (
    select * from {{ ref('stg_github_pull_requests') }}
)

select
    pr_id,
    pr_number,
    title,
    user_login,
    base_ref,

    state,
    draft,
    merged,
    closed_unmerged,

    created_at,
    merged_at,
    closed_at,
    opened_date,
    merged_date,

    hours_to_merge,
    days_to_merge,
    case
        when hours_to_merge is null then null
        when hours_to_merge <  1    then 'under 1h'
        when hours_to_merge <  6    then '1–6h'
        when hours_to_merge < 24    then '6–24h'
        when hours_to_merge < 72    then '1–3d'
        else                             'over 3d'
    end                                             as merge_speed_bucket

from prs
