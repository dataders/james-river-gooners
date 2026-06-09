-- Daily CI trend per workflow: runs, failures, failure rate, durations, with a
-- 7-day rolling failure rate for alerting. Grain: (run_date, workflow_name).
with runs as (
    select * from {{ ref('stg_workflow_runs') }}
),

daily as (
    select
        run_date,
        workflow_name,
        count(*)                                                 as runs,
        count(*) filter (where failed)                           as failures,
        count(*) filter (where succeeded)                        as successes,
        round(
            100.0 * count(*) filter (where failed)
            / nullif(count(*) filter (where failed or succeeded), 0)
        , 1)                                                     as failure_rate_pct,
        round(avg(duration_seconds)::numeric, 1)                 as avg_duration_seconds,
        round(quantile_cont(duration_seconds, 0.95)::numeric, 1) as p95_duration_seconds
    from runs
    group by run_date, workflow_name
)

select
    *,
    round(avg(failure_rate_pct) over (
        partition by workflow_name
        order by run_date
        range between interval 6 days preceding and current row
    ), 1)                                                        as rolling_7d_failure_rate_pct,
    sum(runs) over (
        partition by workflow_name
        order by run_date
        range between interval 6 days preceding and current row
    )                                                            as rolling_7d_runs
from daily
order by run_date desc, workflow_name
