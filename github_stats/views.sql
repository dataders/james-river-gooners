-- Derived stats views over the raw tables the GitHub-stats dlt pipeline loads.
--
-- The pipeline applies this file (idempotent CREATE OR REPLACE) in its own
-- dataset schema after each load, so the views always exist alongside the raw
-- issues / pull_requests / commits / workflow_runs / scraper_run_metrics tables.
-- {schema} is substituted at runtime with the pipeline's dataset_name.
--
-- These are the "shaped" answers to the request: open/closed/merged counts,
-- workflow failure rate + run-time percentiles, and items processed.

-- Single-row repo snapshot — the headline numbers.
create or replace view {schema}.v_repo_overview as
select
  (select count(*) from {schema}.issues where state = 'open' and not is_pull_request)        as open_issues,
  (select count(*) from {schema}.issues where state = 'closed' and not is_pull_request)       as closed_issues,
  (select count(*) from {schema}.pull_requests where state = 'open')                          as open_prs,
  (select count(*) from {schema}.pull_requests where merged)                                  as merged_prs,
  (select count(*) from {schema}.pull_requests where state = 'closed' and not merged)          as closed_unmerged_prs,
  (select count(*) from {schema}.commits)                                                     as commits_loaded,
  (select count(*) from {schema}.workflow_runs)                                               as workflow_runs_loaded,
  (select round(avg(hours_to_merge)::numeric, 2) from {schema}.pull_requests where merged)    as avg_hours_to_merge;

-- Per-workflow run-time + failure-rate rollup.
create or replace view {schema}.v_workflow_run_stats as
select
  name                                                                   as workflow_name,
  count(*)                                                               as total_runs,
  count(*) filter (where failed)                                        as failed_runs,
  count(*) filter (where succeeded)                                     as succeeded_runs,
  round(
    count(*) filter (where failed)::numeric
      / nullif(count(*) filter (where failed or succeeded), 0),
    4
  )                                                                      as failure_rate,
  round(avg(duration_seconds)::numeric, 1)                              as avg_duration_seconds,
  round(
    (percentile_cont(0.5) within group (order by duration_seconds))::numeric, 1
  )                                                                      as p50_duration_seconds,
  round(
    (percentile_cont(0.95) within group (order by duration_seconds))::numeric, 1
  )                                                                      as p95_duration_seconds,
  max(created_at)                                                       as last_run_at
from {schema}.workflow_runs
group by name
order by total_runs desc;

-- Per-day per-workflow trend (runs, failures, failure rate, avg duration).
create or replace view {schema}.v_workflow_daily as
select
  date_trunc('day', created_at)                                        as day,
  name                                                                  as workflow_name,
  count(*)                                                              as runs,
  count(*) filter (where failed)                                       as failures,
  round(
    count(*) filter (where failed)::numeric
      / nullif(count(*) filter (where failed or succeeded), 0),
    4
  )                                                                     as failure_rate,
  round(avg(duration_seconds)::numeric, 1)                             as avg_duration_seconds
from {schema}.workflow_runs
group by 1, 2
order by 1 desc, 2;

-- Pull-request throughput by day opened.
create or replace view {schema}.v_pull_request_daily as
select
  date_trunc('day', created_at)                                        as day,
  count(*)                                                             as opened,
  count(*) filter (where merged)                                       as merged,
  count(*) filter (where state = 'closed' and not merged)              as closed_unmerged,
  round(avg(hours_to_merge) filter (where merged)::numeric, 2)         as avg_hours_to_merge
from {schema}.pull_requests
group by 1
order by 1 desc;

-- Issue throughput by day opened.
create or replace view {schema}.v_issue_daily as
select
  date_trunc('day', created_at)                                        as day,
  count(*)                                                             as opened,
  count(*) filter (where state = 'closed')                             as closed
from {schema}.issues
where not is_pull_request
group by 1
order by 1 desc;

-- Items processed by the scrapers, per metric per day (parsed from run logs).
create or replace view {schema}.v_scraper_items_daily as
select
  date_trunc('day', m.run_started_at)                                  as day,
  m.metric,
  sum(m.value)                                                         as total,
  count(distinct m.run_id)                                             as runs
from {schema}.scraper_run_metrics m
group by 1, 2
order by 1 desc, 2;
