with source as (
    select * from {{ source('gooners', 'users') }}
)

select
    id                                                          as user_id,
    email,
    cannon_bidder_id,
    first_seen_at,
    last_sign_in_at,

    -- DuckDB: datediff returns integer days directly
    datediff('day', first_seen_at, current_timestamp)          as tenure_days,

    last_sign_in_at >= current_timestamp - interval '30 days'  as is_active_30d,
    cannon_bidder_id is not null and cannon_bidder_id <> ''    as has_bidder_id

from source
