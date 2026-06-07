with source as (
    select * from {{ source('gooners', 'lot_enrichment') }}
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
        category,
        raw_category,
        source,
        image_url,
        detail_url,

        -- Enrichment fields
        brand,
        model_or_sku,
        condition,
        product_url,
        confidence,
        model                                    as enrichment_model,

        -- Ordinal confidence (useful for sorting/filtering)
        case confidence
            when 'high'   then 2
            when 'medium' then 1
            else               0
        end                                      as confidence_rank,

        -- Flags
        brand is not null and brand <> ''        as has_brand,
        model_or_sku is not null
            and model_or_sku <> ''               as has_model,
        product_url is not null
            and product_url <> ''               as has_product_url,

        updated_at

    from source
)

select * from cleaned
