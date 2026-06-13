with source as (
    select * from {{ source('gooners', 'lots') }}
),

cleaned as (
    select
        -- Keys
        auction_safe_id,
        item_id,
        auction_id,
        auction_title,
        lot_number,

        -- Content
        title,
        description,
        category,
        raw_category,
        source,
        detail_url,
        -- images is copied as a json array (supabase_app/pipeline.py column hint);
        -- json_array_length gives the count, 0 when null.
        coalesce(json_array_length(images), 0) as image_count,

        -- Status
        archived,
        closed,

        -- Financials
        current_bid,
        final_bid,
        total_bids,
        unique_bidders,

        -- Timestamps
        scraped_at,
        updated_at,
        end_date,
        auction_end_date

    from source
)

select * from cleaned
