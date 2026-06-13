# Supabase migrations

## How migrations are applied

Migrations in this project are applied via the **Supabase MCP `apply_migration` tool**, not the Supabase CLI (`supabase migration up` / `supabase db push`). The remote `schema_migrations` table therefore tracks each migration by a timestamp assigned at application time, not by the local `0001_`-style filename prefix.

This means:

- **Renaming local files** has no effect on the remote — the remote state is frozen at the timestamp recorded when `apply_migration` was called.
- **Filename prefixes** (`0001_`, `0002_`, …) are for human readability and approximate ordering only. They are not enforced by any tooling.
- **Duplicate prefixes** (e.g. `0003_ignored.sql` and `0003b_ebay_comps.sql`) indicate two migrations applied at roughly the same stage. The `b` suffix marks the one applied second per the remote timestamp.

## Remote migration state

| Local file | Remote name | Remote version (timestamp) |
|---|---|---|
| `0001_favorites.sql` | *(applied before tracking started)* | *(not tracked)* |
| `0002_cannon_credentials.sql` | cannon_credentials | 20260604190602 |
| `0003_ignored.sql` | ignored | 20260605003927 |
| `0003b_ebay_comps.sql` | ebay_comps | 20260605004711 |
| `0004_ebay_comps_retention.sql` | 0004_ebay_comps_retention | 20260605014107 |
| `0005_comp_ledger_views.sql` | 0005_comp_ledger_views | 20260605015826 |
| `0006_sold_history.sql` | 0006_sold_history | 20260605033550 |
| `0006b_category_mappings.sql` | *(not yet applied — scraper-only infra)* | *(not tracked)* |
| `0007_lots.sql` | lots | 20260605133620 |
| `0007b_users.sql` | 0007_users | 20260605184033 |
| `0008_gate_resale_intelligence_behind_auth.sql` | gate_resale_intelligence_behind_auth | 20260605191049 |
| `0009_lot_enrichment.sql` | lot_enrichment | 20260605190910 |
| `0009b_cannons_comps.sql` | cannons_comps | 20260605202621 |
| `0010_nomic_embeddings.sql` | 0010_nomic_embeddings | 20260606014910 |
| `0017_lots_card_views.sql` | 0010_lots_card_views | 20260609131909 |

Note: `0008_gate_...` and `0009_lot_enrichment.sql` were applied in reverse numeric order (lot_enrichment first, then gate); the local numbers predate that swap.

Note: `0017_lots_card_views.sql` was applied while still named `0010_lots_card_views` (the remote name is frozen at that value), then the local file was renamed to `0017_` to clear the prefix collision with `0010_nomic_embeddings.sql`.

Note: `0021_filter_preferences.sql` was applied while named `0019_filter_preferences` (the remote name is frozen at that value), then the local file was renamed to `0021_` to clear the prefix collision with `0019_active_lot_filter_bounds.sql` (`0020_` is reserved for the admin dashboard migration).

## Adding a new migration

1. Write your SQL as `supabase/migrations/<next>_<name>.sql`.
2. Apply it: use the Supabase MCP `apply_migration` tool (or `apply_migration` in the Supabase dashboard SQL editor).
3. Update the table above in this README.
