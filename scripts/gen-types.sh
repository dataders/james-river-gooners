#!/usr/bin/env bash
# Regenerate src/types/database.types.ts from the live Supabase schema.
#
# Run via `npm run gen:types`. Auth (pick whichever you have):
#   - SUPABASE_ACCESS_TOKEN  — a personal access token (sbp_…); preferred, uses
#     the HTTPS management API (IPv4-friendly), no DB connection needed.
#   - SUPABASE_POSTGRES_URL  — a direct/session-pooler connection string; used
#     as a fallback when no access token is set.
#
# The Supabase CLI version is PINNED: typegen output formatting can change
# between releases, which would surface as spurious drift in CI. Bump here and
# in .github/workflows/types-drift.yml together, then regenerate.
set -euo pipefail

CLI_VERSION="2.105.0"
PROJECT_ID="cjvllfqldyzsnsjiucks"
OUT="src/types/database.types.ts"

HEADER="// AUTO-GENERATED Supabase database types — do NOT edit by hand.
// Regenerate with \`npm run gen:types\` (see scripts/gen-types.sh) whenever a
// migration under supabase/migrations/ changes the schema. The Supabase view/
// table/function shapes here are the source of truth the typed browser client
// (src/lib/supabase.js) flows into the data hooks.
"

gen() {
  if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
    npx --yes "supabase@${CLI_VERSION}" gen types typescript --project-id "$PROJECT_ID"
  elif [ -n "${SUPABASE_POSTGRES_URL:-}" ]; then
    npx --yes "supabase@${CLI_VERSION}" gen types typescript --db-url "$SUPABASE_POSTGRES_URL"
  else
    echo "gen-types: set SUPABASE_ACCESS_TOKEN (preferred) or SUPABASE_POSTGRES_URL" >&2
    exit 1
  fi
}

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
{ printf '%s\n' "$HEADER"; gen; } > "$tmp"
mv "$tmp" "$OUT"
echo "gen-types: wrote $OUT"
