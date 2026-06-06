with source as (
    select * from {{ source('gooners', 'users') }}
)

select
    id                                           as user_id,
    email,
    cannon_bidder_id,
    first_seen_at,
    last_sign_in_at,

    -- Days since first seen (user tenure)
    (current_timestamp - first_seen_at)::numeric / 86400 as tenure_days,

    -- Active in last 30 days
    last_sign_in_at >= current_timestamp - interval '30 days' as is_active_30d,

    -- Has linked their Cannon's bidder ID
    cannon_bidder_id is not null and cannon_bidder_id <> '' as has_bidder_id

from source
