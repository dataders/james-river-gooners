-- Items the scrapers processed, one row per (run_id, metric), parsed from
-- workflow-run logs by the pipeline (e.g. items_scraped, lots_upserted).
with source as (
    select * from {{ source('github_stats', 'scraper_run_metrics') }}
)

select
    -- Keys
    run_id,
    metric,

    -- Measure
    value,

    -- Run context
    workflow_name,
    head_branch,
    event,
    conclusion,

    -- Timestamps + derived dimensions
    run_started_at,
    date_trunc('day', run_started_at)::date     as metric_date

from source
