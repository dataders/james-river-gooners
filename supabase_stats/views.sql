-- Shaped reliability / load / performance views over the raw metric snapshots
-- the Supabase-stats dlt pipeline loads.
--
-- The pipeline applies this file (idempotent CREATE OR REPLACE) in its own
-- dataset schema after each load, so the views always exist alongside the raw
-- metric_samples table. {schema} is substituted at runtime with the dataset name.
--
-- metric_samples is long-format: one row per (scraped_at, metric, label set),
-- with value, metric_type (counter/gauge), subsystem (host/database/…) and
-- pillar (reliability/load/performance). Counters are cumulative, so the rate
-- views diff within a time window per series (max-min); a counter reset shows
-- as a one-window dip, which is acceptable for a monitoring view.

-- What's being collected, and how fresh — the exporter's own health check.
create or replace view {schema}.v_metric_catalog as
select
  metric,
  subsystem,
  pillar,
  metric_type,
  count(*)                                     as samples,
  count(distinct label_hash)                   as series,
  min(scraped_at)                              as first_seen,
  max(scraped_at)                              as last_seen
from {schema}.metric_samples
group by 1, 2, 3, 4
order by subsystem, metric;

-- One row per scrape run — gap detection for the exporter itself.
create or replace view {schema}.v_scrape_runs as
select
  scraped_at,
  count(*)                                     as samples,
  count(distinct metric)                       as metrics,
  count(distinct label_hash)                   as series
from {schema}.metric_samples
group by 1
order by 1 desc;

-- Latest host load snapshot (load averages + memory/disk utilisation).
create or replace view {schema}.v_host_load_latest as
with latest as (
  select max(scraped_at) as ts from {schema}.metric_samples where subsystem = 'host'
),
g as (
  select metric, value
  from {schema}.metric_samples, latest
  where scraped_at = latest.ts and label_hash is not null
)
select
  (select ts from latest)                                                   as scraped_at,
  (select avg(value) from g where metric = 'node_load1')                    as load1,
  (select avg(value) from g where metric = 'node_load5')                    as load5,
  (select avg(value) from g where metric = 'node_load15')                   as load15,
  (select max(value) from g where metric = 'node_memory_MemTotal_bytes')    as mem_total_bytes,
  (select max(value) from g where metric = 'node_memory_MemAvailable_bytes') as mem_available_bytes,
  round(100.0 * (1 - (
      (select max(value) from g where metric = 'node_memory_MemAvailable_bytes')
      / nullif((select max(value) from g where metric = 'node_memory_MemTotal_bytes'), 0)
  ))::numeric, 1)                                                            as mem_used_pct,
  round(100.0 * (1 - (
      (select sum(value) from g where metric = 'node_filesystem_avail_bytes')
      / nullif((select sum(value) from g where metric = 'node_filesystem_size_bytes'), 0)
  ))::numeric, 1)                                                            as disk_used_pct;

-- Latest database connection saturation (in-use vs max_connections). The
-- Supabase exporter reports current connections per username
-- (connection_stats_connection_count) and the ceiling as
-- max_connections_connection_count.
create or replace view {schema}.v_connection_saturation as
with latest as (
  select max(scraped_at) as ts from {schema}.metric_samples
  where metric = 'connection_stats_connection_count'
)
select
  latest.ts                                                                 as scraped_at,
  sum(value)                                                                as connections_in_use,
  (select max(value) from {schema}.metric_samples
     where metric = 'max_connections_connection_count' and scraped_at = latest.ts) as max_connections,
  round(100.0 * sum(value) / nullif((select max(value) from {schema}.metric_samples
     where metric = 'max_connections_connection_count' and scraped_at = latest.ts), 0), 1) as connection_used_pct
from {schema}.metric_samples, latest
where metric = 'connection_stats_connection_count' and scraped_at = latest.ts
group by latest.ts;

-- Hourly cache-hit ratio (a key performance signal): block hits vs reads.
create or replace view {schema}.v_cache_hit_hourly as
with windows as (
  select metric, label_hash,
         date_trunc('hour', scraped_at)            as hour,
         max(value) - min(value)                   as delta
  from {schema}.metric_samples
  where metric in ('pg_stat_database_blks_hit_total', 'pg_stat_database_blks_read_total')
  group by 1, 2, 3
)
select
  hour,
  sum(delta) filter (where metric = 'pg_stat_database_blks_hit_total')      as blks_hit,
  sum(delta) filter (where metric = 'pg_stat_database_blks_read_total')     as blks_read,
  round(100.0 * sum(delta) filter (where metric = 'pg_stat_database_blks_hit_total')
    / nullif(sum(delta), 0), 2)                                            as cache_hit_pct
from windows
group by 1
order by 1 desc;

-- Hourly transaction throughput + rollback ratio (load + reliability).
create or replace view {schema}.v_transaction_hourly as
with windows as (
  select metric, label_hash,
         date_trunc('hour', scraped_at)            as hour,
         greatest(max(value) - min(value), 0)      as delta
  from {schema}.metric_samples
  where metric in ('pg_stat_database_xact_commit_total', 'pg_stat_database_xact_rollback_total')
  group by 1, 2, 3
)
select
  hour,
  sum(delta) filter (where metric = 'pg_stat_database_xact_commit_total')   as commits,
  sum(delta) filter (where metric = 'pg_stat_database_xact_rollback_total') as rollbacks,
  round(sum(delta) / 3600.0, 2)                                             as txns_per_sec,
  round(100.0 * sum(delta) filter (where metric = 'pg_stat_database_xact_rollback_total')
    / nullif(sum(delta), 0), 3)                                            as rollback_pct
from windows
group by 1
order by 1 desc;

-- Hourly reliability errors (deadlocks + conflicts), as window deltas.
create or replace view {schema}.v_db_errors_hourly as
with windows as (
  select metric, label_hash,
         date_trunc('hour', scraped_at)            as hour,
         greatest(max(value) - min(value), 0)      as delta
  from {schema}.metric_samples
  where metric in ('pg_stat_database_deadlocks_total', 'pg_stat_database_conflicts_total')
  group by 1, 2, 3
)
select
  hour,
  sum(delta) filter (where metric = 'pg_stat_database_deadlocks_total')     as deadlocks,
  sum(delta) filter (where metric = 'pg_stat_database_conflicts_total')     as conflicts
from windows
group by 1
order by 1 desc;
