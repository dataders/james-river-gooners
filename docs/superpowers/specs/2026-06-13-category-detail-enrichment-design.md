# Category-aware detail enrichment (enrich v6)

## Problem

LLM enrichment (`scraper/enrich.py`) identifies a lot only when it can pin a
**brand + model**. On a validation slice of 200 lots from auction
`0AErP0C_gtgBaTyNzS-pOQ`, 94 lots enriched to nothing. Bucketing the misses:

- **28 furniture** ("Mid-century modern style tulip table", "Italian Rococo side chair")
- **28 decorative / ceramics / paintings** (some are art: "Helen Lord watercolor landscape, signed")
- 25 jewelry / precious metal (correctly blank — melt value, no brand)
- 13 other (collectibles)

~20% of the auction is furniture + decorative arts whose resale identity is
**style + material + form** (furniture) or **artist + medium + subject** (art),
not brand + model. The model already reads these from the description text; it
just has nowhere to put them, so the lot falls through the medium/high gate that
drives the Supabase mirror, the ✨ Identified filter, and eBay comps.

## Design

Add a **category-dependent detail set**: the model picks a `detailCategory`, then
fills the keys that matter for that category. One shared `detailConfidence` covers
the bag and folds into the existing gate.

### Schema / prompt (`scraper/enrich.py`, `ENRICHMENT_SCHEMA_VERSION` 5 → 6)

New structured-output fields:

- `detail_category` — enum `furniture | art | ceramics_glass | other`.
- `details` — a fixed superset object (keeps json_schema valid:
  `additionalProperties: false`, all keys required) with every possible key as a
  string defaulting `""`:
  `{style, material, form, artist, medium, subject, maker, pattern}`.
  The model fills only the keys for the chosen category.
- `detail_confidence` — enum `low | medium | high`.

Per-category key sets (prompt guidance + Python pruning):

| detailCategory  | keys filled              |
| --------------- | ------------------------ |
| `furniture`     | style, material, form    |
| `art`           | artist, medium, subject  |
| `ceramics_glass`| maker, pattern, material |
| `other`         | (none — rely on brand/model) |

Prompt also instructs: when `brand` is empty, compose `search_query` from the
detail keys (→ "mid-century walnut credenza", "Helen Lord watercolor winter
landscape").

### Confidence + gate

- `enrichmentConfidence = max(brand, model, detail)` — a confident
  furniture/art lot now clears the medium/high bar.
- When `detail_confidence` is low, `details` and `detailCategory` are cleared to
  `""` before storage, so only medium/high detail persists (the user's "only save
  medium/high guesses" requirement).

### Storage shape

`details` is stored as a **JSON-encoded string** in the read model
(NDJSON/Parquet) and as a `text` column in Supabase — matching the existing
`key_attributes` / `secondary_items` pattern. Pruned to the category's keys with
empties dropped, so a furniture row stores `{"style": ..., "material": ...,
"form": ...}` and an art row stores `{"artist": ..., "medium": ...}`.

### Surfaces

- **`scraper/supabase_enrichment.py`** — add `detail_category`, `details`,
  `detail_confidence` to `ENRICHMENT_COLUMNS`, `enrichment_row`, and
  `load_prior_enrichment_from_supabase` (so unchanged-lot reuse carries them).
- **`supabase/migrations/0020_lot_enrichment_detail.sql`** — add the 3 columns;
  recreate `public_lot_enrichment` to expose them (security_invoker keeps the
  0008 auth gate).
- **`src/utils/enrichment.js`** — `getDisplayEnrichment` label falls back to a
  category-aware compose (furniture → style+material+form; art → artist+medium;
  ceramics → maker+pattern) when there is no brand+model; `mapEnrichmentRow` maps
  the 3 new fields.
- **Comps — no change.** `ebay_query.enriched_exact_phrase` already gates on
  `enrichmentConfidence in (medium, high)` and prefers the composed `searchQuery`,
  so detail-identified lots get comps for free once searchQuery is populated.

### Re-enrich

Bumping `ENRICHMENT_SCHEMA_VERSION` to `6` invalidates every `enrichmentInputHash`,
forcing a one-time re-enrich. Run `--estimate-only` first, then stage the batch
backfill (50% cost).

## Out of scope (follow-up)

- Treating a legible **artist signature as a brand** for finer art comps — the
  `art` category captures artist/medium/subject, but the comp still routes through
  `searchQuery`, not a brand-confidence path. Good enough for now.
- Collectibles (records, sports cards) — fall to `other`, stay unenriched.

## Tests

- `scraper/test_enrich.py` — detail parsing, pruning by category, low-confidence
  clears the bag, `enrichmentConfidence = max(brand, model, detail)`, schema bump.
- `scraper/test_supabase_enrichment.py` — row projection + prior-load include the
  new columns.
- `src/utils/enrichment.test.js` — label fallback from details.
