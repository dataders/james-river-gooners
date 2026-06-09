-- Items the scrapers processed per day, by metric (parsed from run logs).
-- Grain: (metric_date, metric) — e.g. items_scraped, lots_upserted,
-- sold_lots_upserted. rolling_7d_total smooths the per-day spikes.
with metrics as (
    select * from {{ ref('stg_scraper_run_metrics') }}
),

daily as (
    select
        metric_date,
        metric,
        sum(value)                                  as total,
        count(distinct run_id)                      as runs,
        round(avg(value)::numeric, 1)               as avg_per_run
    from metrics
    group by metric_date, metric
)

select
    *,
    sum(total) over (
        partition by metric
        order by metric_date
        range between interval 6 days preceding and current row
    )                                               as rolling_7d_total
from daily
order by metric_date desc, metric
