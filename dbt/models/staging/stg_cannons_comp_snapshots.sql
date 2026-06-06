with source as (
    select * from {{ source('gooners', 'cannons_comp_snapshots') }}
),

-- Latest generation per (auction, item)
latest as (
    select *,
        dense_rank() over (
            partition by auction_safe_id, item_id
            order by generated_at desc
        ) as gen_rank
    from source
),

cleaned as (
    select
        id,
        auction_safe_id,
        item_id,
        rank                                     as comp_rank,   -- 0-based, best first
        match_title,
        sold_price,
        sold_date,
        thumbnail_url,
        detail_url,
        auction_title                            as comp_auction_title,
        source,
        similarity,
        generated_at,
        ingested_at
    from latest
    where gen_rank = 1
)

select * from cleaned
