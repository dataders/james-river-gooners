-- Daily scrape quality dashboard. One row per (scrape_date, source).
-- Use this as the foundation for SLA monitoring.
--
-- Three throughput dimensions are tracked independently:
--   enrichment_rate_pct  — new LLM identifications / active lots scraped that day
--   ebay_match_rate_pct  — eBay queries that returned a match
--   cannons_coverage_pct — active lots with a fresh Cannon's prior computed that day
--
-- Note: enrichment and comps run on their own schedules (may lag scraping by hours
-- or days). A low rate on a given day may mean the sub-job didn't run, not failure.
-- Watch the rolling_7d_* columns for true trend signal.

with lots_scraped as (
    -- What each scraper touched on each day.
    select
        date_trunc('day', scraped_at)::date         as scrape_date,
        source,
        count(distinct auction_safe_id)              as auctions_touched,
        count(*)                                     as lots_scraped,
        count(case when not archived then 1 end)     as active_lots_scraped,
        count(case when archived then 1 end)         as archived_lots_scraped
    from {{ source('gooners', 'lots') }}
    where scraped_at is not null
    group by 1, 2
),

enrichment_activity as (
    -- New/updated enrichment records by day and source.
    -- Joins to lots to get the source each enriched lot belongs to.
    select
        date_trunc('day', le.updated_at)::date       as scrape_date,
        l.source,
        count(distinct le.item_id)                   as lots_enriched,
        count(distinct case when le.confidence = 'high'   then le.item_id end) as high_conf,
        count(distinct case when le.confidence = 'medium' then le.item_id end) as medium_conf
    from {{ source('gooners', 'lot_enrichment') }} le
    join {{ source('gooners', 'lots') }} l
        using (auction_safe_id, item_id)
    where le.updated_at is not null
    group by 1, 2
),

ebay_activity as (
    -- eBay API queries made on each day.
    -- Uses all rows (including no-result ones) to count true API call volume.
    select
        date_trunc('day', ec.ingested_at)::date      as scrape_date,
        l.source,
        -- Distinct queries: one query = one (item, source_query, fetch_time) triplet
        count(distinct
            ec.auction_safe_id || '|' || ec.item_id
            || '|' || ec.source_query
            || '|' || ec.fetched_at::text
        )                                             as ebay_queries,
        count(distinct case when ec.item_web_url is not null
            then ec.item_id end)                     as lots_with_ebay_comps,
        count(case when ec.item_web_url is not null then 1 end) as ebay_matches
    from {{ source('gooners', 'ebay_comp_snapshots') }} ec
    left join {{ source('gooners', 'lots') }} l
        using (auction_safe_id, item_id)
    where ec.ingested_at is not null
    group by 1, 2
),

cannons_activity as (
    -- Cannon's CLIP comp runs on each day.
    -- generated_at is a single value per scraper run — count distinct values
    -- to see how many auction-level runs happened.
    select
        date_trunc('day', cc.generated_at)::date     as scrape_date,
        l.source,
        count(distinct cc.generated_at)              as cannons_runs,
        count(distinct cc.item_id)                   as lots_with_cannons_priors,
        round(avg(cc.similarity), 3)                 as avg_similarity_score
    from {{ source('gooners', 'cannons_comp_snapshots') }} cc
    left join {{ source('gooners', 'lots') }} l
        using (auction_safe_id, item_id)
    where cc.generated_at is not null
    group by 1, 2
),

all_activity_dates as (
    select scrape_date, source from lots_scraped
    union
    select scrape_date, source from enrichment_activity
    union
    select scrape_date, source from ebay_activity
    union
    select scrape_date, source from cannons_activity
),

base as (
    select
        d.scrape_date,
        d.source,

        -- Scrape volume
        coalesce(ls.auctions_touched, 0)                           as auctions_touched,
        coalesce(ls.lots_scraped, 0)                               as lots_scraped,
        coalesce(ls.active_lots_scraped, 0)                        as active_lots_scraped,
        coalesce(ls.archived_lots_scraped, 0)                      as archived_lots_scraped,

        -- Enrichment throughput
        coalesce(en.lots_enriched, 0)                              as lots_enriched,
        coalesce(en.high_conf, 0)                                  as enriched_high_conf,
        coalesce(en.medium_conf, 0)                                as enriched_medium_conf,
        -- Rate: new enrichments vs active lots scraped that day
        case when coalesce(ls.active_lots_scraped, 0) > 0
            then round(
                100.0 * coalesce(en.lots_enriched, 0) / ls.active_lots_scraped, 1
            )
        end                                                        as enrichment_rate_pct,

        -- eBay comp throughput
        coalesce(eb.ebay_queries, 0)                               as ebay_queries,
        coalesce(eb.lots_with_ebay_comps, 0)                       as lots_with_ebay_comps,
        coalesce(eb.ebay_matches, 0)                               as ebay_matches,
        case when coalesce(eb.ebay_queries, 0) > 0
            then round(100.0 * coalesce(eb.ebay_matches, 0) / eb.ebay_queries, 1)
        end                                                        as ebay_match_rate_pct,
        case when coalesce(ls.active_lots_scraped, 0) > 0
            then round(
                100.0 * coalesce(eb.lots_with_ebay_comps, 0) / ls.active_lots_scraped, 1
            )
        end                                                        as ebay_coverage_pct,

        -- Cannon's priors throughput
        coalesce(cc.cannons_runs, 0)                               as cannons_runs,
        coalesce(cc.lots_with_cannons_priors, 0)                   as lots_with_cannons_priors,
        cc.avg_similarity_score,
        case when coalesce(ls.active_lots_scraped, 0) > 0
            then round(
                100.0 * coalesce(cc.lots_with_cannons_priors, 0) / ls.active_lots_scraped, 1
            )
        end                                                        as cannons_coverage_pct,

        -- Activity flags — useful for detecting when a sub-job went dark
        coalesce(ls.lots_scraped, 0) > 0                          as had_scrape_activity,
        coalesce(en.lots_enriched, 0) > 0                         as had_enrichment_activity,
        coalesce(eb.ebay_queries, 0) > 0                          as had_ebay_activity,
        coalesce(cc.cannons_runs, 0) > 0                          as had_cannons_activity

    from all_activity_dates d
    left join lots_scraped ls       using (scrape_date, source)
    left join enrichment_activity en using (scrape_date, source)
    left join ebay_activity eb       using (scrape_date, source)
    left join cannons_activity cc    using (scrape_date, source)
)

select
    *,

    -- 7-day rolling averages for trend-smoothing (SLA baseline)
    round(avg(enrichment_rate_pct) over (
        partition by source
        order by scrape_date
        rows between 6 preceding and current row
    ), 1)                                                          as rolling_7d_enrichment_rate,

    round(avg(ebay_match_rate_pct) over (
        partition by source
        order by scrape_date
        rows between 6 preceding and current row
    ), 1)                                                          as rolling_7d_ebay_match_rate,

    round(avg(cannons_coverage_pct) over (
        partition by source
        order by scrape_date
        rows between 6 preceding and current row
    ), 1)                                                          as rolling_7d_cannons_coverage,

    -- Days since each sub-job last ran (alerts for silent failures)
    scrape_date - max(case when had_enrichment_activity then scrape_date end) over (
        partition by source
        order by scrape_date
        rows between unbounded preceding and current row
    )                                                              as days_since_enrichment,

    scrape_date - max(case when had_ebay_activity then scrape_date end) over (
        partition by source
        order by scrape_date
        rows between unbounded preceding and current row
    )                                                              as days_since_ebay_comps,

    scrape_date - max(case when had_cannons_activity then scrape_date end) over (
        partition by source
        order by scrape_date
        rows between unbounded preceding and current row
    )                                                              as days_since_cannons_priors

from base
order by scrape_date desc, source
