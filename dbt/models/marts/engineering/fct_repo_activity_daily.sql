-- Daily engineering throughput: PRs opened/merged, issues opened/closed, and
-- commits authored. One row per calendar day with any activity (a union spine
-- across the five activity streams, so a day shows up if anything happened).
with prs as (
    select * from {{ ref('stg_github_pull_requests') }}
),
issues as (
    select * from {{ ref('stg_github_issues') }}
),
commits as (
    select * from {{ ref('stg_github_commits') }}
),

prs_opened as (
    select
        opened_date                         as activity_date,
        count(*)                            as prs_opened,
        count(*) filter (where draft)       as prs_opened_draft
    from prs
    group by opened_date
),
prs_merged as (
    select
        merged_date                         as activity_date,
        count(*)                            as prs_merged,
        round(avg(hours_to_merge)::numeric, 2) as avg_hours_to_merge
    from prs
    where merged_date is not null
    group by merged_date
),
issues_opened as (
    select opened_date as activity_date, count(*) as issues_opened
    from issues
    group by opened_date
),
issues_closed as (
    select closed_date as activity_date, count(*) as issues_closed
    from issues
    where closed_date is not null
    group by closed_date
),
commits_daily as (
    select
        authored_date                       as activity_date,
        count(*)                            as commits,
        count(distinct author_login)        as distinct_authors
    from commits
    group by authored_date
),

spine as (
    select activity_date from prs_opened
    union select activity_date from prs_merged
    union select activity_date from issues_opened
    union select activity_date from issues_closed
    union select activity_date from commits_daily
)

select
    s.activity_date,

    coalesce(po.prs_opened, 0)              as prs_opened,
    coalesce(po.prs_opened_draft, 0)        as prs_opened_draft,
    coalesce(pm.prs_merged, 0)              as prs_merged,
    pm.avg_hours_to_merge,

    coalesce(io.issues_opened, 0)           as issues_opened,
    coalesce(ic.issues_closed, 0)           as issues_closed,

    coalesce(c.commits, 0)                  as commits,
    coalesce(c.distinct_authors, 0)         as distinct_authors,

    sum(coalesce(pm.prs_merged, 0)) over (
        order by s.activity_date
        range between interval 6 days preceding and current row
    )                                       as rolling_7d_prs_merged,
    sum(coalesce(c.commits, 0)) over (
        order by s.activity_date
        range between interval 6 days preceding and current row
    )                                       as rolling_7d_commits

from spine s
left join prs_opened    po on po.activity_date = s.activity_date
left join prs_merged    pm on pm.activity_date = s.activity_date
left join issues_opened io on io.activity_date = s.activity_date
left join issues_closed ic on ic.activity_date = s.activity_date
left join commits_daily c  on c.activity_date  = s.activity_date
order by s.activity_date desc
