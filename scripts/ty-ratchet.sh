#!/usr/bin/env bash
# Scraper `ty` type-check ratchet.
#
# The scraper is now fully ty-clean (BASELINE=0): this gate keeps it that way —
# any new ty diagnostic fails CI. scraper/ty.toml ignores environment-artifact
# rules (unresolved-import / possibly-missing-submodule), i.e. third-party deps
# the type-check job doesn't install (import sanity is covered by the ruff
# pyflakes F-codes), so what's left is real type errors.
#
# The ty version AND target python version are pinned so the count is identical
# in dev and CI (it drifts between python versions otherwise). If a future ty/
# typeshed bump surfaces unavoidable new findings, raise BASELINE deliberately.
set -uo pipefail

BASELINE=0
TY_VERSION="0.0.44"
PYTHON_VERSION="3.13"

cd "$(dirname "$0")/../scraper"
out=$(uvx "ty@${TY_VERSION}" check . --python-version "$PYTHON_VERSION" 2>&1)

if printf '%s\n' "$out" | grep -qE 'Found [0-9]+ diagnostic'; then
  count=$(printf '%s\n' "$out" | grep -oE 'Found [0-9]+ diagnostic' | grep -oE '[0-9]+' | tail -1)
elif printf '%s\n' "$out" | grep -q 'All checks passed'; then
  count=0
else
  printf '%s\n' "$out" | tail -20
  echo "❌ ty-ratchet: could not parse ty output (did ty fail to run?)."
  exit 1
fi

echo "ty diagnostics: $count (ceiling $BASELINE)"
if [ "$count" -gt "$BASELINE" ]; then
  printf '%s\n' "$out" | grep -oE '^(error|warning)\[[a-z-]+\]' | sort | uniq -c | sort -rn
  echo "❌ ty diagnostics rose to $count (ceiling $BASELINE). Fix the new finding(s), or raise BASELINE if intentional."
  exit 1
fi
if [ "$count" -lt "$BASELINE" ]; then
  echo "✅ below ceiling — lower BASELINE in scripts/ty-ratchet.sh to $count to lock it in."
else
  echo "✅ at ceiling $BASELINE — scraper is ty-clean."
fi
