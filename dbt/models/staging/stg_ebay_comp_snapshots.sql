with source as (
    select * from {{ source('gooners', 'ebay_comp_snapshots') }}
),

cleaned as (
    select
        id,
        auction_safe_id,
        item_id,
        auction_id,
        lot_number,
        cannons_title,
        cannons_description,
        current_bid,
        total_bids,

        -- Query metadata
        status,
        query,
        source_query,
        search_url,
        detail_url,
        fetched_at,
        warning,

        -- eBay match
        ebay_item_id,
        title                                   as ebay_title,
        price_value                             as ebay_price,
        price_currency,
        shipping_label,
        sold_date                               as ebay_sold_date,
        sold_date_label,
        thumbnail_url                           as ebay_thumbnail_url,
        item_web_url                            as ebay_item_url,
        condition                               as ebay_condition,
        match_confidence,

        ingested_at,

        -- Derived: days between eBay sale and Supabase ingestion (comp freshness)
        (ingested_at::date - sold_date)::int    as comp_age_days

    from source
    where item_web_url is not null           -- exclude "no result" rows
)

select * from cleaned
