with source as (
    select * from {{ source('gooners', 'sold_lots') }}
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
        image_url,
        detail_url,

        -- Financials
        final_bid,
        total_bids,
        unique_bidders,

        -- Timestamps
        sold_at,
        updated_at,

        -- Derived time dimensions
        date_trunc('month', sold_at)::date                     as sold_month,
        date_trunc('quarter', sold_at)::date                   as sold_quarter,
        extract(year from sold_at)::int                        as sold_year,
        extract(dow from sold_at)::int                         as sold_dow,   -- 0=Sun
        extract(hour from sold_at)::int                        as sold_hour,

        -- Price bands for distribution charts
        case
            when final_bid <   10  then 'under $10'
            when final_bid <   25  then '$10–$25'
            when final_bid <   50  then '$25–$50'
            when final_bid <  100  then '$50–$100'
            when final_bid <  250  then '$100–$250'
            when final_bid <  500  then '$250–$500'
            when final_bid < 1000  then '$500–$1k'
            else                        'over $1k'
        end                                                    as price_bucket,

        -- Engagement flags
        coalesce(unique_bidders, 0) >= 2                       as is_competitive,
        coalesce(unique_bidders, 0)                            as unique_bidders_safe,
        coalesce(total_bids, 0)                                as total_bids_safe

    from source
    where final_bid is not null
      and final_bid > {{ var('min_sold_price') }}
)

select * from cleaned
