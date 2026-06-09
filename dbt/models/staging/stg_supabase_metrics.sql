-- Typed, long-format Supabase platform-metric samples.
-- One row per (scraped_at, metric, label_hash). Parses the common Prometheus
-- labels out of labels_json so downstream models can group without re-parsing,
-- and adds time dimensions. Kept long (not pivoted) — the marts shape it.

with source as (
    select * from {{ source('supabase_metrics', 'metric_samples') }}
),

cleaned as (
    select
        -- Series identity
        scraped_at,
        metric,
        label_hash,
        lower(metric_type)                                     as metric_type,
        subsystem,
        pillar,
        is_curated,

        -- Value
        value,

        -- Common labels, pulled out of the JSON for convenience. Null when the
        -- label is absent on a given series.
        labels_json,
        json_extract_string(labels_json, '$.datname')         as datname,
        json_extract_string(labels_json, '$.state')           as activity_state,
        json_extract_string(labels_json, '$.mode')            as cpu_mode,
        json_extract_string(labels_json, '$.cpu')             as cpu,
        json_extract_string(labels_json, '$.device')          as device,
        json_extract_string(labels_json, '$.mountpoint')      as mountpoint,

        -- Derived time dimensions
        date_trunc('hour', scraped_at)                         as scraped_hour,
        date_trunc('day', scraped_at)::date                    as scraped_date,

        -- A counter's value only means something as a difference over time.
        lower(metric_type) = 'counter'                         as is_counter

    from source
    where value is not null
)

select * from cleaned
