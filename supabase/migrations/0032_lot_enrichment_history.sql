-- Lot-enrichment history (append-only audit / "the good parts of SCD Type II").
--
-- `lot_enrichment` is a serving read model — its only consumer (the browser, via
-- public_lot_enrichment) wants exactly the *current* identified product, so we
-- keep it Type 1 (overwrite in place) rather than versioning it (which would put
-- an is_current filter on every read and bloat the hot table). To still answer
-- "how did this lot's enrichment change across schema/model versions" — useful
-- for auditing prompt/model changes and feeding the comp-quality eval — every
-- *meaningful* version is snapshotted here instead.
--
-- Capture is DB-side via triggers, so it's correct regardless of which code path
-- wrote (sync / batch / inline scrape / backfill) and can't be forgotten:
--   * AFTER INSERT  → always record the first version.
--   * AFTER UPDATE  → record only when `input_hash` actually changed, so the
--     hourly scrape's no-op re-upserts of unchanged identified lots (ON CONFLICT
--     DO UPDATE always fires) don't pile up duplicate history rows.
-- The hash fingerprints the enrichment inputs (schema + model + text + photos),
-- so "hash changed" is exactly "a different version was produced".

create table if not exists lot_enrichment_history (
  id              bigint generated always as identity primary key,
  enriched_at     timestamptz not null default now(),
  auction_safe_id text not null,
  item_id         text not null,
  schema_version  text,
  model           text,
  input_hash      text,
  confidence      text,
  brand           text,
  model_or_sku    text,
  product_type    text,
  search_query    text,
  detail_category text,
  details         text,
  detail_confidence text
);

-- Read a lot's version history newest-first.
create index if not exists lot_enrichment_history_item_idx
  on lot_enrichment_history (auction_safe_id, item_id, enriched_at desc);

create or replace function log_lot_enrichment_history()
returns trigger as $$
begin
  insert into lot_enrichment_history (
    auction_safe_id, item_id, schema_version, model, input_hash, confidence,
    brand, model_or_sku, product_type, search_query,
    detail_category, details, detail_confidence
  ) values (
    new.auction_safe_id, new.item_id, new.schema_version, new.model,
    new.input_hash, new.confidence, new.brand, new.model_or_sku,
    new.product_type, new.search_query, new.detail_category, new.details,
    new.detail_confidence
  );
  return null;  -- AFTER trigger; return value is ignored
end;
$$ language plpgsql;

drop trigger if exists lot_enrichment_history_insert on lot_enrichment;
create trigger lot_enrichment_history_insert
  after insert on lot_enrichment
  for each row execute function log_lot_enrichment_history();

drop trigger if exists lot_enrichment_history_update on lot_enrichment;
create trigger lot_enrichment_history_update
  after update on lot_enrichment
  for each row
  when (old.input_hash is distinct from new.input_hash)
  execute function log_lot_enrichment_history();

-- Scraper-internal / analytical: RLS on, no policy, so only the secret key
-- (service_role) touches it. Not exposed to the browser.
alter table lot_enrichment_history enable row level security;
