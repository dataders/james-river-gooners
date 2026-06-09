-- Hourly database reliability / load / performance for the Supabase Postgres.
-- One row per hour. Connection saturation and db size come from gauges
-- (averaged per scrape, then over the hour); cache-hit, throughput, and error
-- counts come from counter deltas (int_supabase_metric_rates). Columns are null
-- for any hour/metric the exporter didn't capture.

with samples as (
    select * from {{ ref('stg_supabase_metrics') }} where subsystem = 'database'
),

rates as (
    select * from {{ ref('int_supabase_metric_rates') }} where subsystem = 'database'
),

hours as (
    select distinct scraped_hour from samples
),

-- Total connections per scrape (sum across usernames), then hourly stats.
conn_per_scrape as (
    select scraped_hour, scraped_at, sum(value) as connections
    from samples
    where metric = 'connection_stats_connection_count'
    group by 1, 2
),

conn as (
    select
        scraped_hour,
        avg(connections)                                               as connections_avg,
        max(connections)                                               as connections_max
    from conn_per_scrape
    group by 1
),

max_conn as (
    select scraped_hour, max(value) as max_connections
    from samples
    where metric = 'max_connections_connection_count'
    group by 1
),

-- Total database size per scrape (sum across databases), then hourly mean.
size_per_scrape as (
    select scraped_hour, scraped_at, sum(value) as db_size_bytes
    from samples
    where metric = 'pg_database_size_bytes'
    group by 1, 2
),

db_size as (
    select scraped_hour, avg(db_size_bytes) as db_size_bytes
    from size_per_scrape
    group by 1
),

-- Counter increases over the hour (summed across databases/series).
counters as (
    select
        scraped_hour,
        sum(delta) filter (where metric = 'pg_stat_database_blks_hit_total')      as blks_hit,
        sum(delta) filter (where metric = 'pg_stat_database_blks_read_total')     as blks_read,
        sum(delta) filter (where metric = 'pg_stat_database_xact_commit_total')   as commits,
        sum(delta) filter (where metric = 'pg_stat_database_xact_rollback_total') as rollbacks,
        sum(delta) filter (where metric = 'pg_stat_database_deadlocks_total')     as deadlocks,
        sum(delta) filter (where metric = 'pg_stat_database_conflicts_total')     as conflicts
    from rates
    where delta is not null
    group by 1
)

select
    h.scraped_hour,

    -- Load: connection saturation
    round(cn.connections_avg, 1)                                       as connections_avg,
    cn.connections_max,
    mc.max_connections,
    round(100.0 * cn.connections_avg / nullif(mc.max_connections, 0), 1) as connection_used_pct,

    -- Performance: buffer cache hit ratio
    ct.blks_hit,
    ct.blks_read,
    round(100.0 * ct.blks_hit / nullif(ct.blks_hit + ct.blks_read, 0), 2) as cache_hit_pct,

    -- Load: transaction throughput
    ct.commits,
    round(ct.commits / 3600.0, 2)                                      as commits_per_sec,

    -- Reliability: rollback ratio + error counts
    ct.rollbacks,
    round(100.0 * ct.rollbacks / nullif(ct.commits + ct.rollbacks, 0), 3) as rollback_pct,
    coalesce(ct.deadlocks, 0)                                          as deadlocks,
    coalesce(ct.conflicts, 0)                                          as conflicts,

    -- Footprint
    ds.db_size_bytes

from hours h
left join conn     cn using (scraped_hour)
left join max_conn mc using (scraped_hour)
left join db_size  ds using (scraped_hour)
left join counters ct using (scraped_hour)
order by h.scraped_hour desc
