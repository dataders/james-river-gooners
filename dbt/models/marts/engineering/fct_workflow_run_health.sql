-- Lifetime CI reliability per workflow. One row per workflow_name.
-- The headline "which workflows are flaky/slow" table for the dashboard.
--
-- failure_rate_pct is computed over decided runs only (failed or succeeded) so
-- in-progress/cancelled/skipped runs don't dilute it. Percentiles use DuckDB's
-- quantile_cont over duration_seconds (nulls ignored).
with runs as (
    select * from {{ ref('stg_workflow_runs') }}
)

select
    workflow_name,

    count(*)                                                    as total_runs,
    count(*) filter (where failed)                              as failed_runs,
    count(*) filter (where succeeded)                           as succeeded_runs,
    count(*) filter (where not failed and not succeeded)        as other_runs,

    round(
        100.0 * count(*) filter (where failed)
        / nullif(count(*) filter (where failed or succeeded), 0)
    , 1)                                                        as failure_rate_pct,

    round(avg(duration_seconds)::numeric, 1)                    as avg_duration_seconds,
    round(quantile_cont(duration_seconds, 0.5)::numeric, 1)     as p50_duration_seconds,
    round(quantile_cont(duration_seconds, 0.95)::numeric, 1)    as p95_duration_seconds,
    round(max(duration_seconds)::numeric, 1)                    as max_duration_seconds,

    min(created_at)                                             as first_run_at,
    max(created_at)                                             as last_run_at,
    datediff('day', max(created_at), current_timestamp)         as days_since_last_run

from runs
group by workflow_name
order by total_runs desc
