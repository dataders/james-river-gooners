-- Every user must have an engagement tier — no nulls allowed.
select user_id
from {{ ref('fct_user_engagement') }}
where engagement_tier is null
