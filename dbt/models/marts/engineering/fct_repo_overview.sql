-- Single-row headline snapshot for the dashboard's top tiles.
-- Issues here are true issues (PRs already excluded in staging).
with prs as (select * from {{ ref('stg_github_pull_requests') }}),
issues as (select * from {{ ref('stg_github_issues') }}),
commits as (select * from {{ ref('stg_github_commits') }}),
runs as (select * from {{ ref('stg_workflow_runs') }})

select
    (select count(*) from issues where state = 'open')                    as open_issues,
    (select count(*) from issues where state = 'closed')                  as closed_issues,

    (select count(*) from prs where state = 'open')                       as open_prs,
    (select count(*) from prs where merged)                               as merged_prs,
    (select count(*) from prs where closed_unmerged)                      as closed_unmerged_prs,
    (select round(avg(hours_to_merge)::numeric, 2) from prs where merged) as avg_hours_to_merge,

    (select count(*) from commits)                                        as commits_tracked,
    (select count(distinct author_login) from commits)                    as distinct_authors,

    (select count(*) from runs)                                           as workflow_runs_tracked,
    (select round(
        100.0 * count(*) filter (where failed)
        / nullif(count(*) filter (where failed or succeeded), 0)
    , 1) from runs)                                                       as overall_failure_rate_pct,

    current_timestamp                                                     as generated_at
