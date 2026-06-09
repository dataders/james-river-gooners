-- Hourly host load & performance for the Supabase instance.
-- One row per hour. CPU/network are counters (per-second rates from
-- int_supabase_metric_rates); load averages and memory/disk are gauges
-- (averaged over the hour from the staged samples). Columns are null for any
-- hour/metric the exporter didn't capture — non-fatal by design.

with samples as (
    select * from {{ ref('stg_supabase_metrics') }} where subsystem = 'host'
),

rates as (
    select * from {{ ref('int_supabase_metric_rates') }} where subsystem = 'host'
),

hours as (
    select distinct scraped_hour from samples
),

-- Load averages + memory: simple hourly means of the gauge series.
gauges as (
    select
        scraped_hour,
        avg(value) filter (where metric = 'node_load1')                 as load1,
        avg(value) filter (where metric = 'node_load5')                 as load5,
        avg(value) filter (where metric = 'node_load15')                as load15,
        avg(value) filter (where metric = 'node_memory_MemTotal_bytes') as mem_total_bytes,
        avg(value) filter (where metric = 'node_memory_MemAvailable_bytes') as mem_available_bytes
    from samples
    group by 1
),

-- Disk: root filesystem utilisation (falls back to null if '/' isn't labelled).
disk as (
    select
        scraped_hour,
        avg(value) filter (where metric = 'node_filesystem_avail_bytes') as fs_avail_bytes,
        avg(value) filter (where metric = 'node_filesystem_size_bytes')  as fs_size_bytes
    from samples
    where mountpoint = '/'
    group by 1
),

-- CPU: per scrape, busy = 1 - idle_rate / total_rate; then average over the hour.
cpu_per_scrape as (
    select
        scraped_hour,
        scraped_at,
        sum(per_second_rate)                                            as total_rate,
        sum(per_second_rate) filter (where cpu_mode <> 'idle')          as busy_rate
    from rates
    where metric = 'node_cpu_seconds_total' and per_second_rate is not null
    group by 1, 2
),

cpu as (
    select
        scraped_hour,
        avg(100.0 * busy_rate / nullif(total_rate, 0))                  as cpu_busy_pct
    from cpu_per_scrape
    group by 1
),

-- Network throughput: hourly mean of per-second byte rates across interfaces.
net as (
    select
        scraped_hour,
        avg(per_second_rate) filter (where metric = 'node_network_receive_bytes_total')  as net_rx_bytes_per_sec,
        avg(per_second_rate) filter (where metric = 'node_network_transmit_bytes_total') as net_tx_bytes_per_sec
    from rates
    where per_second_rate is not null
    group by 1
)

select
    h.scraped_hour,

    round(g.load1, 2)                                                    as load1,
    round(g.load5, 2)                                                    as load5,
    round(g.load15, 2)                                                   as load15,

    round(c.cpu_busy_pct, 1)                                             as cpu_busy_pct,

    g.mem_total_bytes,
    g.mem_available_bytes,
    round(100.0 * (1 - g.mem_available_bytes / nullif(g.mem_total_bytes, 0)), 1) as mem_used_pct,

    d.fs_avail_bytes                                                     as disk_avail_bytes,
    d.fs_size_bytes                                                      as disk_size_bytes,
    round(100.0 * (1 - d.fs_avail_bytes / nullif(d.fs_size_bytes, 0)), 1) as disk_used_pct,

    round(n.net_rx_bytes_per_sec, 0)                                     as net_rx_bytes_per_sec,
    round(n.net_tx_bytes_per_sec, 0)                                     as net_tx_bytes_per_sec

from hours h
left join gauges g using (scraped_hour)
left join disk   d using (scraped_hour)
left join cpu    c using (scraped_hour)
left join net    n using (scraped_hour)
order by h.scraped_hour desc
