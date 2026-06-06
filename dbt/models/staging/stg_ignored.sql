with source as (
    select * from {{ source('gooners', 'ignored') }}
),

cleaned as (
    select
        user_id,
        item_key,

        split_part(item_key, ':', 1)             as auction_safe_id,
        substring(item_key from position(':' in item_key) + 1) as item_id,

        created_at,
        date_trunc('day', created_at)::date      as ignored_date,
        extract(dow from created_at)::int        as ignored_dow,
        extract(hour from created_at)::int       as ignored_hour

    from source
)

select * from cleaned
