-- Per-series rates for counter metrics.
-- Counters are cumulative, so a single sample is meaningless on its own — the
-- signal is the increase between consecutive scrapes. For each series
-- (metric + label set) ordered by scrape time, compute the delta and the
-- per-second rate vs the previous sample. Counter resets (value goes down, e.g.
-- after a restart) yield a negative delta, which we null out rather than emit a
-- spurious spike. Gauges pass through unchanged with a null rate.

with samples as (
    select * from {{ ref('stg_supabase_metrics') }}
),

with_prev as (
    select
        *,
        lag(value) over w        as prev_value,
        lag(scraped_at) over w   as prev_scraped_at
    from samples
    window w as (
        partition by metric, label_hash
        order by scraped_at
    )
),

rated as (
    select
        scraped_at,
        scraped_hour,
        scraped_date,
        metric,
        label_hash,
        metric_type,
        subsystem,
        pillar,
        is_curated,
        datname,
        activity_state,
        cpu_mode,
        device,
        mountpoint,
        value,
        prev_value,

        -- Seconds since the previous sample of this series.
        case when prev_scraped_at is not null
            then date_diff('second', prev_scraped_at, scraped_at)
        end                                                    as elapsed_seconds,

        -- Counter increase since the previous sample (null on reset / first row).
        case
            when not is_counter then null
            when prev_value is null then null
            when value < prev_value then null      -- counter reset
            else value - prev_value
        end                                                    as delta,

        -- Per-second rate = delta / elapsed. Null for gauges, first samples,
        -- resets, and zero-elapsed (same-second retry).
        case
            when not is_counter then null
            when prev_value is null or value < prev_value then null
            when date_diff('second', prev_scraped_at, scraped_at) > 0
                then (value - prev_value)
                     / date_diff('second', prev_scraped_at, scraped_at)
        end                                                    as per_second_rate

    from with_prev
)

select * from rated
