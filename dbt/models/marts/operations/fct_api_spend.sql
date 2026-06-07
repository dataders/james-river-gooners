-- Daily API usage and estimated spend. One row per activity_date.
--
-- Cost estimation uses token counts from dbt vars (no actual token logging in the DB).
-- Update vars in dbt_project.yml when you change models or prompt structure.
-- eBay Browse API defaults to $0 (free tier); set ebay_api_cost_per_query > 0 if billed.
--
-- Cumulative cost columns let you answer "how much has enrichment cost since launch?"

with ebay_daily as (
    select
        date_trunc('day', ingested_at)::date                        as activity_date,
        -- True API call count: distinct (item, source_query, fetch_timestamp)
        count(distinct
            auction_safe_id || '|' || item_id
            || '|' || source_query
            || '|' || fetched_at::text
        )                                                           as ebay_queries,
        count(case when item_web_url is not null then 1 end)        as ebay_matches,
        count(case when item_web_url is null then 1 end)            as ebay_no_results,
        count(distinct auction_safe_id)                             as auctions_queried,
        count(distinct item_id)                                     as items_queried,
        count(distinct source_query)                                as query_strategies_used
    from {{ source('gooners', 'ebay_comp_snapshots') }}
    where ingested_at is not null
    group by 1
),

anthropic_by_model as (
    -- One row per (date, enrichment_model): tracks cost per model version
    select
        date_trunc('day', updated_at)::date                         as activity_date,
        model                                                        as enrichment_model,
        count(*)                                                     as enrichment_calls,
        count(case when confidence = 'high'   then 1 end)           as high_conf_calls,
        count(case when confidence = 'medium' then 1 end)           as medium_conf_calls
    from {{ source('gooners', 'lot_enrichment') }}
    where updated_at is not null
    group by 1, 2
),

anthropic_daily as (
    -- Roll up to date level; keep dominant model for reference
    select
        activity_date,
        sum(enrichment_calls)                                        as enrichment_calls,
        sum(high_conf_calls)                                         as high_conf_calls,
        sum(medium_conf_calls)                                       as medium_conf_calls,
        mode(enrichment_model)                                       as primary_model,
        count(distinct enrichment_model)                             as distinct_models_used
    from anthropic_by_model
    group by activity_date
),

all_dates as (
    select activity_date from ebay_daily
    union
    select activity_date from anthropic_daily
),

daily as (
    select
        d.activity_date,

        -- eBay usage
        coalesce(e.ebay_queries, 0)                                 as ebay_queries,
        coalesce(e.ebay_matches, 0)                                 as ebay_matches,
        coalesce(e.ebay_no_results, 0)                              as ebay_no_results,
        coalesce(e.auctions_queried, 0)                             as ebay_auctions_queried,
        coalesce(e.items_queried, 0)                                as ebay_items_queried,
        coalesce(e.query_strategies_used, 0)                        as ebay_query_strategies,
        case when coalesce(e.ebay_queries, 0) > 0
            then round(100.0 * coalesce(e.ebay_matches, 0) / e.ebay_queries, 1)
        end                                                         as ebay_match_rate_pct,

        -- eBay cost
        round(
            coalesce(e.ebay_queries, 0) * {{ var('ebay_api_cost_per_query') }},
            4
        )                                                           as ebay_cost_usd,

        -- Anthropic usage
        coalesce(a.enrichment_calls, 0)                             as enrichment_calls,
        coalesce(a.high_conf_calls, 0)                              as enrichment_high_conf,
        coalesce(a.medium_conf_calls, 0)                            as enrichment_medium_conf,
        a.primary_model                                              as enrichment_primary_model,
        coalesce(a.distinct_models_used, 0)                         as enrichment_distinct_models,

        -- Anthropic estimated cost breakdown
        -- Input cost: est input tokens × calls × rate
        round(
            coalesce(a.enrichment_calls, 0)
            * {{ var('est_enrichment_input_tokens') }}
            / 1000000.0
            * {{ var('anthropic_haiku_input_cost_per_1m') }},
            4
        )                                                           as anthropic_input_cost_usd,

        -- Output cost: est output tokens × calls × rate
        round(
            coalesce(a.enrichment_calls, 0)
            * {{ var('est_enrichment_output_tokens') }}
            / 1000000.0
            * {{ var('anthropic_haiku_output_cost_per_1m') }},
            4
        )                                                           as anthropic_output_cost_usd,

        -- Total Anthropic cost for the day
        round(
            coalesce(a.enrichment_calls, 0) * (
                {{ var('est_enrichment_input_tokens') }}
                / 1000000.0 * {{ var('anthropic_haiku_input_cost_per_1m') }}
                + {{ var('est_enrichment_output_tokens') }}
                / 1000000.0 * {{ var('anthropic_haiku_output_cost_per_1m') }}
            ),
            4
        )                                                           as anthropic_total_cost_usd

    from all_dates d
    left join ebay_daily e using (activity_date)
    left join anthropic_daily a using (activity_date)
)

select
    *,

    -- Combined daily spend
    round(ebay_cost_usd + anthropic_total_cost_usd, 4)             as total_api_cost_usd,

    -- Cumulative totals — "how much have we spent since the start?"
    round(sum(anthropic_total_cost_usd) over (
        order by activity_date
        rows between unbounded preceding and current row
    ), 2)                                                           as cumulative_anthropic_cost_usd,

    round(sum(ebay_cost_usd) over (
        order by activity_date
        rows between unbounded preceding and current row
    ), 2)                                                           as cumulative_ebay_cost_usd,

    round(sum(ebay_cost_usd + anthropic_total_cost_usd) over (
        order by activity_date
        rows between unbounded preceding and current row
    ), 2)                                                           as cumulative_total_cost_usd,

    -- 30-day rolling spend (budget burn rate)
    round(sum(anthropic_total_cost_usd) over (
        order by activity_date
        rows between 29 preceding and current row
    ), 2)                                                           as rolling_30d_anthropic_cost_usd,

    round(sum(ebay_cost_usd + anthropic_total_cost_usd) over (
        order by activity_date
        rows between 29 preceding and current row
    ), 2)                                                           as rolling_30d_total_cost_usd,

    -- Cost efficiency: $ per successfully enriched lot
    case when enrichment_calls > 0
        then round(anthropic_total_cost_usd / enrichment_calls, 6)
    end                                                             as anthropic_cost_per_enriched_lot,

    -- Cost efficiency: $ per successful eBay match
    case when ebay_matches > 0
        then round(ebay_cost_usd / ebay_matches, 6)
    end                                                             as ebay_cost_per_match

from daily
order by activity_date desc
