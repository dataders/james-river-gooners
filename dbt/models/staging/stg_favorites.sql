with source as (
    select * from {{ source('gooners', 'favorites') }}
),

cleaned as (
    select
        user_id,
        item_key,

        -- Parse "<auctionSafeId>:<itemId>" composite key
        split_part(item_key, ':', 1)             as auction_safe_id,
        -- Remainder after first colon handles item_ids that contain colons
        substring(item_key from position(':' in item_key) + 1) as item_id,

        created_at,
        date_trunc('day', created_at)::date      as favorited_date,
        extract(dow from created_at)::int        as favorited_dow,
        extract(hour from created_at)::int       as favorited_hour

    from source
)

select * from cleaned
