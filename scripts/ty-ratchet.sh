#!/usr/bin/env bash
# Scraper `ty` type-check ratchet.
#
# ty (Astral, pre-1.0) is noisy on the largely-untyped scraper, so instead of
# pass/fail-on-zero we ratchet the DIAGNOSTIC COUNT: it may not rise above the
# baseline. A new type error fails CI; fixing errors (or installing the deps that
# resolve imports) lowers the count, then you lower BASELINE here to lock it in.
# This replaces the old advisory `continue-on-error` step.
#
# The ty version AND target python version are pinned so the count is identical
# in dev and CI (it drifts between python versions otherwise).
set -uo pipefail

BASELINE=237
TY_VERSION="0.0.44"
PYTHON_VERSION="3.13"

cd "$(dirname "$0")/../scraper"
out=$(uvx "ty@${TY_VERSION}" check . --python-version "$PYTHON_VERSION" 2>&1)

if ! printf '%s\n' "$out" | grep -qE 'Found [0-9]+ diagnostics'; then
  printf '%s\n' "$out" | tail -20
  echo "❌ ty-ratchet: could not parse ty output (did ty fail to run?)."
  exit 1
fi

count=$(printf '%s\n' "$out" | grep -oE 'Found [0-9]+ diagnostics' | grep -oE '[0-9]+' | tail -1)

echo "ty diagnostics: $count (ceiling $BASELINE)"
if [ "$count" -gt "$BASELINE" ]; then
  printf '%s\n' "$out" | grep -oE '^(error|warning)\[[a-z-]+\]' | sort | uniq -c | sort -rn
  echo "❌ ty diagnostics rose to $count (ceiling $BASELINE). Fix the new finding(s), or raise BASELINE if intentional."
  exit 1
fi
if [ "$count" -lt "$BASELINE" ]; then
  echo "✅ below ceiling — lower BASELINE in scripts/ty-ratchet.sh to $count to lock it in."
else
  echo "✅ at ceiling $BASELINE."
fi
