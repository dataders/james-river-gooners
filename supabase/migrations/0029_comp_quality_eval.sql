-- A/B eval of comp quality across the comp-pipeline factors (RFC #290 follow-up).
-- One row per (run, lot, arm, candidate): stores the full candidate set per arm
-- with each candidate's cosine similarity to the lot's Nomic embedding, so the
-- distributions are queryable later (not just per-arm means). Written by
-- scraper/ab_comp_quality.py. Scraper-internal: RLS on, no select policy.

create table if not exists comp_quality_eval (
  run_id          text not null,
  auction_safe_id text not null,
  item_id         text not null,
  arm             text not null,           -- baseline | filters | enrichment | rerank
  ebay_item_id    text,
  rank            int,                      -- 1-based position within the arm
  similarity      float,                   -- cosine(lot_emb, candidate_emb)
  query           text,                     -- the search phrase the arm used
  title           text,
  sold_price      numeric,
  sold_date       date,
  created_at      timestamptz not null default now()
);

create index if not exists comp_quality_eval_run on comp_quality_eval (run_id, arm);
create index if not exists comp_quality_eval_lot on comp_quality_eval (auction_safe_id, item_id);

alter table comp_quality_eval enable row level security;
