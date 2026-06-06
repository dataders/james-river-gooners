-- Fail if any auction has negative total GMV (would indicate a data error).
select auction_safe_id, total_gmv
from {{ ref('dim_auctions') }}
where total_gmv < 0
